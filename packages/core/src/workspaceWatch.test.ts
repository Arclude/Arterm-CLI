import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { gitWorkspaceWatcher } from "./workspaceWatch.js";

/**
 * A real repository, because the whole point of the watcher is that git is the
 * candidate set. A fake `git` would be asserting on the fixture.
 */
function repo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "arterm-watch-")));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: dir, stdio: "pipe", encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  writeFileSync(join(dir, "tracked.txt"), "one\ntwo\nthree\n");
  writeFileSync(join(dir, ".gitignore"), "ignored/\n");
  git("add", "-A");
  git("commit", "-qm", "base");
  return dir;
}

describe("the git workspace watcher", () => {
  let dir: string;
  beforeAll(() => {
    dir = repo();
  });

  it("sees a file a command created, which no tool declared", () => {
    // The blind spot itself: `bash` returns a string and names no path, so
    // without this the ledger recorded that nothing happened.
    return (async () => {
      const watcher = gitWorkspaceWatcher();
      const before = await watcher.snapshot(dir);
      expect(before).toBeDefined();
      await writeFile(join(dir, "made-by-shell.txt"), "a\nb\n");
      const { changes } = await watcher.changesSince(before!, dir);
      const made = changes.find((c) => c.path === "made-by-shell.txt");
      expect(made).toBeDefined();
      expect(made?.contentHashAfter).toMatch(/^[0-9a-f]{64}$/);
      // A creation is all addition, counted from the bytes just read.
      expect(made?.added).toBe(2);
      expect(made?.removed).toBe(0);
      await rm(join(dir, "made-by-shell.txt"));
    })();
  });

  it("credits only THIS call's lines, not every edit since HEAD", async () => {
    // The misattribution the ledger exists to prevent: measuring against HEAD
    // would hand a shell command every earlier edit to the same file.
    const watcher = gitWorkspaceWatcher();
    await writeFile(join(dir, "tracked.txt"), "one\ntwo\nthree\nfour\n");
    const before = await watcher.snapshot(dir);
    await writeFile(join(dir, "tracked.txt"), "one\ntwo\nthree\nfour\nfive\n");
    const { changes } = await watcher.changesSince(before!, dir);
    const edited = changes.find((c) => c.path === "tracked.txt");
    expect(edited?.added).toBe(1);
    execFileSync("git", ["checkout", "--", "tracked.txt"], { cwd: dir });
  });

  it("says nothing about a file the call did not touch", async () => {
    // A file dirty BEFORE the call must not be recorded as this call's work,
    // which is why the comparison is content and not "is it dirty".
    const watcher = gitWorkspaceWatcher();
    await writeFile(join(dir, "tracked.txt"), "one\ntwo\nthree\nedited\n");
    const before = await watcher.snapshot(dir);
    await writeFile(join(dir, "other.txt"), "x\n");
    const { changes } = await watcher.changesSince(before!, dir);
    expect(changes.map((c) => c.path)).toEqual(["other.txt"]);
    await rm(join(dir, "other.txt"));
    execFileSync("git", ["checkout", "--", "tracked.txt"], { cwd: dir });
  });

  it("records a deletion as a path with no digest", async () => {
    // Absent is a fact: "gone" and "unchanged" are different answers, and only
    // the missing digest tells them apart.
    const watcher = gitWorkspaceWatcher();
    const before = await watcher.snapshot(dir);
    await rm(join(dir, "tracked.txt"));
    const { changes } = await watcher.changesSince(before!, dir);
    const gone = changes.find((c) => c.path === "tracked.txt");
    expect(gone).toBeDefined();
    expect(gone?.contentHashAfter).toBeUndefined();
    execFileSync("git", ["checkout", "--", "tracked.txt"], { cwd: dir });
  });

  it("does not watch what git ignores", async () => {
    // The stated scope limit. Build output is not evidence, and walking it on
    // every shell call is what the git candidate set exists to avoid.
    const watcher = gitWorkspaceWatcher();
    await mkdir(join(dir, "ignored"), { recursive: true });
    const before = await watcher.snapshot(dir);
    await writeFile(join(dir, "ignored", "build.js"), "noise\n");
    const { changes } = await watcher.changesSince(before!, dir);
    expect(changes).toEqual([]);
  });

  it("has nothing to watch outside a repository", async () => {
    const plain = realpathSync(mkdtempSync(join(tmpdir(), "arterm-nogit-")));
    expect(await gitWorkspaceWatcher().snapshot(plain)).toBeUndefined();
  });
});

/**
 * Naming the other suspects.
 *
 * The watcher can prove a file MOVED around a command and never that the
 * command moved it — identifying the writer needs privileges or a per-command
 * overlay. What it CAN do is enumerate who else was capable of it, so an empty
 * list becomes evidence rather than an unstated assumption.
 */
describe("who else could have written it", () => {
  let dir: string;
  beforeAll(() => {
    dir = repo();
  });

  it("reports nothing running when nothing is", async () => {
    const w = gitWorkspaceWatcher({ witnesses: () => [] });
    const before = await w.snapshot(dir);
    await writeFile(join(dir, "quiet.txt"), "a\n");
    const { changes, concurrent } = await w.changesSince(before!, dir);
    expect(changes.some((c) => c.path === "quiet.txt")).toBe(true);
    // An empty ARRAY, not an absent field: the question was asked.
    expect(concurrent).toEqual([]);
    await rm(join(dir, "quiet.txt"));
  });

  it("unions both ends of the window, not just the survivors", async () => {
    // A daemon that died halfway through could have written the file just as
    // easily as one that outlived the command, so an intersection would clear
    // exactly the cases this exists to flag.
    let call = 0;
    const w = gitWorkspaceWatcher({
      witnesses: () => (call++ === 0 ? ["tsc --watch"] : ["vite dev"]),
    });
    const before = await w.snapshot(dir);
    await writeFile(join(dir, "busy.txt"), "a\n");
    const { concurrent } = await w.changesSince(before!, dir);
    expect(concurrent).toEqual(["tsc --watch", "vite dev"]);
    await rm(join(dir, "busy.txt"));
  });

  it("survives a witness source that throws", async () => {
    // The ledger observes the run; it may never be the thing that ends it.
    const w = gitWorkspaceWatcher({
      witnesses: () => {
        throw new Error("registry exploded");
      },
    });
    const before = await w.snapshot(dir);
    expect(before).toBeDefined();
    await expect(w.changesSince(before!, dir)).resolves.toBeDefined();
  });
});
