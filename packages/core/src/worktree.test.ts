import { execFile } from "node:child_process";
import { promises as fs, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureWorktree, createWorktree, isGitRepo, removeWorktree } from "./worktree.js";

const run = promisify(execFile);

async function hasGit(): Promise<boolean> {
  try {
    await run("git", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

const gitAvailable = await hasGit();

describe.skipIf(!gitAvailable)("worktree", () => {
  let repo: string;

  beforeEach(async () => {
    repo = realpathSync(await fs.mkdtemp(join(tmpdir(), "arterm-wt-test-")));
    await run("git", ["init"], { cwd: repo });
    await run("git", ["config", "user.email", "t@example.com"], { cwd: repo });
    await run("git", ["config", "user.name", "Test"], { cwd: repo });
    await fs.writeFile(join(repo, "seed.txt"), "seed\n");
    await run("git", ["add", "-A"], { cwd: repo });
    await run("git", ["commit", "-m", "init"], { cwd: repo });
  });

  afterEach(async () => {
    await fs.rm(repo, { recursive: true, force: true });
  });

  it("isGitRepo distinguishes repos from plain dirs", async () => {
    expect(await isGitRepo(repo)).toBe(true);
    const plain = await fs.mkdtemp(join(tmpdir(), "arterm-plain-"));
    expect(await isGitRepo(plain)).toBe(false);
    await fs.rm(plain, { recursive: true, force: true });
  });

  it("creates an isolated worktree on a fresh branch", async () => {
    const wt = await createWorktree(repo, "0");
    expect(wt.branch).toBe("arterm/fleet/0");
    expect(await isGitRepo(wt.path)).toBe(true);
    // The seed file from the base commit is present in the worktree.
    expect(await fs.readFile(join(wt.path, "seed.txt"), "utf8")).toContain("seed");
    await removeWorktree(wt, repo, { keepBranch: false });
  });

  it("reports no change for a no-op and a patch after a write", async () => {
    const noop = await createWorktree(repo, "1");
    const before = await captureWorktree(noop);
    expect(before.changed).toBe(false);
    await removeWorktree(noop, repo, { keepBranch: false });

    const wt = await createWorktree(repo, "2");
    await fs.writeFile(join(wt.path, "new.txt"), "hello\n");
    const after = await captureWorktree(wt);
    expect(after.changed).toBe(true);
    expect(after.files).toContain("new.txt");
    expect(after.patch).toContain("hello");
    await removeWorktree(wt, repo, { keepBranch: false });
  });

  it("removeWorktree deregisters the worktree", async () => {
    const wt = await createWorktree(repo, "3");
    await removeWorktree(wt, repo, { keepBranch: false });
    const { stdout } = await run("git", ["worktree", "list"], { cwd: repo });
    expect(stdout).not.toContain(wt.path);
  });
});
