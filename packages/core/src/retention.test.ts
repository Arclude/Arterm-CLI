import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pruneDirByAge } from "./retention.js";

const DAY = 24 * 60 * 60 * 1000;

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), "arterm-retention-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

/** Create a file whose mtime is `ageDays` in the past. */
async function aged(name: string, ageDays: number): Promise<string> {
  const path = join(dir, name);
  await fs.writeFile(path, "x");
  const then = new Date(Date.now() - ageDays * DAY);
  await fs.utimes(path, then, then);
  return path;
}

describe("pruneDirByAge", () => {
  it("deletes past the cutoff and keeps everything newer", async () => {
    const old = await aged("old.txt", 10);
    const fresh = await aged("fresh.txt", 2);
    const removed = await pruneDirByAge(dir, 7);
    expect(removed).toEqual([old]);
    await expect(fs.access(fresh)).resolves.toBeUndefined();
    await expect(fs.access(old)).rejects.toThrow();
  });

  it("an ACTIVE file is safe by construction — appends refresh its mtime", async () => {
    // This is the property that makes age-by-mtime need no bookkeeping about
    // which session is live: a chronicle being appended to is always fresh.
    const active = await aged("current.jsonl", 200);
    await fs.appendFile(active, "record\n"); // the append IS the mtime bump
    expect(await pruneDirByAge(dir, 90)).toEqual([]);
    await expect(fs.access(active)).resolves.toBeUndefined();
  });

  it("undefined means off, and a missing directory is an empty one", async () => {
    await aged("old.txt", 400);
    expect(await pruneDirByAge(dir, undefined)).toEqual([]);
    expect(await pruneDirByAge(join(dir, "never-created"), 7)).toEqual([]);
  });

  it("never recurses into a subdirectory", async () => {
    // The guard against a config typo pointing the pruner somewhere structured:
    // files only, so the worst mistake deletes files in ONE directory.
    const sub = join(dir, "subdir");
    await fs.mkdir(sub);
    const inner = join(sub, "old.txt");
    await fs.writeFile(inner, "x");
    const then = new Date(Date.now() - 400 * DAY);
    await fs.utimes(inner, then, then);
    await fs.utimes(sub, then, then);
    expect(await pruneDirByAge(dir, 7)).toEqual([]);
    await expect(fs.access(inner)).resolves.toBeUndefined();
  });

  it("0 keeps sessionStore's arithmetic: older than nothing is everything", async () => {
    // One meaning across every retention knob — session.maxAgeDays already
    // works this way, and two knobs with two zeros is how a config stops being
    // predictable. "Keep forever" is a large number, not zero.
    await aged("anything.txt", 1);
    const removed = await pruneDirByAge(dir, 0);
    expect(removed).toHaveLength(1);
  });
});
