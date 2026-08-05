import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CheckpointStore, declaredPaths } from "./checkpoint.js";

let home: string;
let work: string;

beforeEach(async () => {
  home = await fs.mkdtemp(join(tmpdir(), "arterm-ckpt-home-"));
  work = await fs.mkdtemp(join(tmpdir(), "arterm-ckpt-work-"));
});
afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
  await fs.rm(work, { recursive: true, force: true });
});

function store(session = "s1"): CheckpointStore {
  return new CheckpointStore(work, session, home);
}

const read = (p: string) => fs.readFile(p, "utf8");

describe("CheckpointStore", () => {
  it("restores a file the turn edited", async () => {
    const file = join(work, "a.ts");
    await fs.writeFile(file, "original\n");
    const s = store();

    s.beginTurn("make it better");
    await s.capture([file]);
    await fs.writeFile(file, "agent's version\n");
    const cp = await s.commitTurn();

    expect(cp).toBeDefined();
    const res = await s.restore(cp?.id ?? "");
    expect(res.restored).toBe(1);
    expect(await read(file)).toBe("original\n");
  });

  it("deletes a file the turn created — undo means it was never there", async () => {
    const file = join(work, "new.ts");
    const s = store();

    s.beginTurn("add a file");
    await s.capture([file]); // does not exist yet
    await fs.writeFile(file, "brand new\n");
    const cp = await s.commitTurn();

    await s.restore(cp?.id ?? "");
    await expect(fs.access(file)).rejects.toThrow();
  });

  it("keeps the state from the START of the turn, not its last edit", async () => {
    const file = join(work, "a.ts");
    await fs.writeFile(file, "v0\n");
    const s = store();

    s.beginTurn("several edits");
    await s.capture([file]);
    await fs.writeFile(file, "v1\n");
    await s.capture([file]); // second tool call in the same turn
    await fs.writeFile(file, "v2\n");
    const cp = await s.commitTurn();

    await s.restore(cp?.id ?? "");
    expect(await read(file)).toBe("v0\n");
  });

  it("rewinds every checkpoint after the target, not just that one", async () => {
    const file = join(work, "a.ts");
    await fs.writeFile(file, "v0\n");
    const s = store();

    s.beginTurn("turn 1");
    await s.capture([file]);
    await fs.writeFile(file, "v1\n");
    const first = await s.commitTurn();

    s.beginTurn("turn 2");
    await s.capture([file]);
    await fs.writeFile(file, "v2\n");
    await s.commitTurn();

    // Rewinding to the first turn must undo the second one too.
    await s.restore(first?.id ?? "");
    expect(await read(file)).toBe("v0\n");
  });

  it("does not rewrite files that already match — mtimes and rebuilds matter", async () => {
    const touched = join(work, "touched.ts");
    const untouched = join(work, "untouched.ts");
    await fs.writeFile(touched, "before\n");
    await fs.writeFile(untouched, "same\n");
    const s = store();

    s.beginTurn("edit one, read the other");
    await s.capture([touched, untouched]);
    await fs.writeFile(touched, "after\n");
    const cp = await s.commitTurn();

    // `untouched` never changed, so it is not even in the checkpoint.
    expect(cp?.entries.map((e) => e.path)).toEqual([touched]);
    const before = (await fs.stat(untouched)).mtimeMs;
    const res = await s.restore(cp?.id ?? "");
    expect(res.restored).toBe(1);
    expect((await fs.stat(untouched)).mtimeMs).toBe(before);
  });

  it("records nothing for a turn that only read files", async () => {
    const file = join(work, "a.ts");
    await fs.writeFile(file, "unchanged\n");
    const s = store();

    s.beginTurn("just looking");
    await s.capture([file]);
    expect(await s.commitTurn()).toBeUndefined();
    expect(await s.list()).toHaveLength(0);
  });

  it("skips symlinks instead of writing through them, and says how many", async () => {
    // The failure this pins: a shipped agent silently wrote through symlinks
    // and hard links, corrupting dotfile managers and package stores.
    const real = join(work, "real.ts");
    const link = join(work, "link.ts");
    await fs.writeFile(real, "real content\n");
    await fs.symlink(real, link);
    const s = store();

    s.beginTurn("touch a link");
    await s.capture([link]);
    await fs.writeFile(real, "changed via link\n");
    const cp = await s.commitTurn();

    // A link has no snapshot to begin with, so there is nothing to restore…
    if (cp) {
      const res = await s.restore(cp.id);
      expect(res.skippedLinks).toBeGreaterThan(0);
      expect(res.restored).toBe(0);
    }
    // …and the real file is left exactly as the agent left it, not half-undone.
    expect(await read(real)).toBe("changed via link\n");
  });

  it("redo goes forward again, because the rewind checkpointed the present first", async () => {
    const file = join(work, "a.ts");
    await fs.writeFile(file, "v0\n");
    const s = store();

    s.beginTurn("do the work");
    await s.capture([file]);
    await fs.writeFile(file, "v1\n");
    const cp = await s.commitTurn();

    await s.restore(cp?.id ?? "");
    expect(await read(file)).toBe("v0\n");

    const redo = s.redoTarget;
    expect(redo).toBeDefined();
    await s.restore(redo ?? "");
    expect(await read(file)).toBe("v1\n");
  });

  it("never touches the user's git directory", async () => {
    // The bug this forecloses: an agent renamed a user's root .git when its
    // checkpoint init failed, severing version control.
    const git = join(work, ".git");
    await fs.mkdir(git);
    await fs.writeFile(join(git, "HEAD"), "ref: refs/heads/main\n");
    const file = join(work, "a.ts");
    await fs.writeFile(file, "v0\n");
    const s = store();

    s.beginTurn("work");
    await s.capture([file]);
    await fs.writeFile(file, "v1\n");
    const cp = await s.commitTurn();
    await s.restore(cp?.id ?? "");

    expect(await read(join(git, "HEAD"))).toBe("ref: refs/heads/main\n");
    expect((await fs.readdir(work)).sort()).toEqual([".git", "a.ts"]);
  });

  it("rejects an unknown id loudly rather than restoring nothing quietly", async () => {
    // A restore that reports success and does nothing is worse than a failure —
    // that exact silent no-op shipped in another agent.
    await expect(store().restore("cp-nope")).rejects.toThrow(/no such checkpoint/);
  });

  it("prunes aged sessions and the objects nothing references", async () => {
    const file = join(work, "a.ts");
    await fs.writeFile(file, "v0\n");
    const s = store("old-session");
    s.beginTurn("work");
    await s.capture([file]);
    await fs.writeFile(file, "v1\n");
    await s.commitTurn();

    const objectsDir = join(home, "checkpoints");
    const countObjects = async (): Promise<number> => {
      let n = 0;
      const walk = async (dir: string): Promise<void> => {
        for (const e of await fs.readdir(dir, { withFileTypes: true })) {
          if (e.isDirectory()) await walk(join(dir, e.name));
          else n += 1;
        }
      };
      await walk(objectsDir);
      return n;
    };
    expect(await countObjects()).toBeGreaterThan(1);

    // 31 days later.
    const pruned = await s.prune(Date.now() + 31 * 24 * 60 * 60 * 1000);
    expect(pruned.sessions).toBe(1);
    expect(pruned.objects).toBeGreaterThan(0);
  });
});

describe("declaredPaths", () => {
  it("names the path a file tool is about to write", () => {
    expect(declaredPaths("write", { path: "a.ts", content: "x" })).toEqual(["a.ts"]);
    expect(declaredPaths("edit", { path: "b.ts" })).toEqual(["b.ts"]);
    expect(declaredPaths("multi_edit", { path: "c.ts" })).toEqual(["c.ts"]);
  });

  it("declares nothing for bash — a shell command names no paths", () => {
    // Not an oversight: `rm -rf` and `sed -i` cannot be snapshotted ahead of
    // time, which is exactly why the UI has to say bash is outside rewind.
    expect(declaredPaths("bash", { command: "rm -rf src/" })).toEqual([]);
  });

  it("ignores path-shaped arguments on read tools", () => {
    expect(declaredPaths("grep", { pattern: "src/**" })).toEqual([]);
    expect(declaredPaths("read", { path: "a.ts" })).toEqual([]);
  });
});
