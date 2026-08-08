import { execFile } from "node:child_process";
import { promises as fs, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyPatch,
  captureWorktree,
  createWorktree,
  isGitRepo,
  removeWorktree,
} from "./worktree.js";

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
    const plain = realpathSync(await fs.mkdtemp(join(tmpdir(), "arterm-plain-")));
    // Stop git's upward discovery at the temp dir — on machines where a parent
    // of tmpdir() is itself a repo (e.g. a dotfiles repo in $HOME), the plain
    // dir would otherwise be "inside" that outer work tree.
    const prevCeiling = process.env.GIT_CEILING_DIRECTORIES;
    process.env.GIT_CEILING_DIRECTORIES = tmpdir();
    try {
      expect(await isGitRepo(plain)).toBe(false);
    } finally {
      // An empty ceiling list is equivalent to unset (process.env can't hold undefined).
      process.env.GIT_CEILING_DIRECTORIES = prevCeiling ?? "";
      await fs.rm(plain, { recursive: true, force: true });
    }
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

  it("applyPatch lands a captured member patch on the main tree", async () => {
    const wt = await createWorktree(repo, "ap1");
    await fs.writeFile(join(wt.path, "feature.txt"), "from member\n");
    const changes = await captureWorktree(wt);
    await removeWorktree(wt, repo, { keepBranch: false });

    const res = await applyPatch(repo, changes.patch);
    expect(res.ok).toBe(true);
    expect(await fs.readFile(join(repo, "feature.txt"), "utf8")).toContain("from member");
  });

  it("applyPatch reports a conflict instead of throwing", async () => {
    const wt = await createWorktree(repo, "ap2");
    await fs.writeFile(join(wt.path, "seed.txt"), "member version\n");
    const changes = await captureWorktree(wt);
    await removeWorktree(wt, repo, { keepBranch: false });

    // Diverge the main tree on the same line so a 3-way merge can't resolve it.
    await fs.writeFile(join(repo, "seed.txt"), "main version\n");
    await run("git", ["add", "-A"], { cwd: repo });
    await run("git", ["commit", "-m", "diverge"], { cwd: repo });

    const res = await applyPatch(repo, changes.patch);
    expect(res.ok).toBe(false);
    expect(res.detail).toBeTruthy();

    // And it reported that WITHOUT leaving the merge behind. `git apply --3way`
    // writes conflict markers into the file and stages them before it exits
    // non-zero, so "we told the caller it failed" used to coexist with a source
    // file that no longer parsed. Observed on a real /team merge: all three of
    // the run's files came out beginning with `<<<<<<< ours`.
    const after = await fs.readFile(join(repo, "seed.txt"), "utf8");
    expect(after).toBe("main version\n");
    expect(after).not.toContain("<<<<<<<");
    const { stdout: staged } = await run("git", ["diff", "--cached", "--name-only"], { cwd: repo });
    expect(staged.trim()).toBe("");
  });

  it("applyPatch removes a file it had to create, when the apply fails", async () => {
    // The restore has to cover "did not exist" too — a conflicted apply can
    // leave behind a file the tree never had, and putting back its old content
    // is not an option when there wasn't any.
    const wt = await createWorktree(repo, "ap3");
    await fs.writeFile(join(wt.path, "brand-new.txt"), "member version\n");
    const changes = await captureWorktree(wt);
    await removeWorktree(wt, repo, { keepBranch: false });

    // Same path, different content, committed on main → the add conflicts.
    await fs.writeFile(join(repo, "brand-new.txt"), "main version\n");
    await run("git", ["add", "-A"], { cwd: repo });
    await run("git", ["commit", "-m", "diverge-new"], { cwd: repo });
    await fs.rm(join(repo, "brand-new.txt"));
    await run("git", ["rm", "-q", "--cached", "brand-new.txt"], { cwd: repo });
    await run("git", ["commit", "-m", "remove it again"], { cwd: repo });

    const res = await applyPatch(repo, changes.patch);
    if (!res.ok) {
      await expect(fs.readFile(join(repo, "brand-new.txt"))).rejects.toThrow();
    }
  });

  it("applyPatch treats an empty patch as a no-op success", async () => {
    expect((await applyPatch(repo, "")).ok).toBe(true);
  });
});
