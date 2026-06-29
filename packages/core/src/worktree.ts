import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

const GIT_OPTS = { windowsHide: true, maxBuffer: 10 * 1024 * 1024 } as const;

/** A git worktree created for an isolated sub-agent run. */
export interface WorktreeHandle {
  /** Absolute path to the isolated worktree (becomes the sub-agent's cwd). */
  path: string;
  /** Temp branch the worktree is checked out on (e.g. "arterm/fleet/0"). */
  branch: string;
  /** Base commit the worktree was created from. */
  baseRef: string;
}

/** What a sub-agent changed inside its worktree. */
export interface WorktreeChanges {
  changed: boolean;
  /** Unified diff of base..HEAD (empty when nothing changed). */
  patch: string;
  /** Files touched relative to the worktree root. */
  files: string[];
}

async function git(cwd: string, args: string[], signal?: AbortSignal): Promise<string> {
  const { stdout } = await run("git", args, { ...GIT_OPTS, cwd, signal });
  return stdout;
}

/** True when `cwd` is inside a git work tree. Never throws. */
export async function isGitRepo(cwd: string, signal?: AbortSignal): Promise<boolean> {
  try {
    const out = await git(cwd, ["rev-parse", "--is-inside-work-tree"], signal);
    return out.trim() === "true";
  } catch {
    return false;
  }
}

/** Repo root (`git rev-parse --show-toplevel`). Throws if `cwd` is not a repo. */
export async function gitRoot(cwd: string, signal?: AbortSignal): Promise<string> {
  const out = await git(cwd, ["rev-parse", "--show-toplevel"], signal);
  return out.trim();
}

/**
 * Create an isolated worktree off HEAD on a fresh temp branch. The returned path
 * is realpath-resolved so it matches what `resolveWithin` (which realpaths cwd)
 * computes — critical on Windows where `%TEMP%` is often an 8.3 short path.
 */
export async function createWorktree(
  repoCwd: string,
  id: string,
  signal?: AbortSignal,
): Promise<WorktreeHandle> {
  const root = await gitRoot(repoCwd, signal);
  const baseRef = (await git(root, ["rev-parse", "HEAD"], signal)).trim();
  const dir = join(tmpdir(), "arterm-wt", `${id}-${randomUUID()}`);
  const branch = `arterm/fleet/${id}`;
  await git(root, ["worktree", "add", "-b", branch, dir, baseRef], signal);
  // realpath only resolves once the dir exists (after `worktree add`).
  let resolved = dir;
  try {
    resolved = realpathSync(dir);
  } catch {
    // Fall back to the raw path if realpath fails (dir should exist by now).
  }
  return { path: resolved, branch, baseRef };
}

/**
 * Stage everything in the worktree, detect changes, and (if any) commit to the
 * temp branch so a patch can be surfaced. Never throws.
 */
export async function captureWorktree(
  h: WorktreeHandle,
  signal?: AbortSignal,
): Promise<WorktreeChanges> {
  try {
    await git(h.path, ["add", "-A"], signal);
    // `diff --cached --quiet` exits non-zero (caught below) when staged changes exist.
    try {
      await git(h.path, ["diff", "--cached", "--quiet"], signal);
      return { changed: false, patch: "", files: [] };
    } catch {
      // There are staged changes — fall through to commit + diff.
    }
    await git(h.path, ["commit", "-m", `arterm fleet: ${h.branch}`], signal);
    const patch = await git(h.path, ["diff", `${h.baseRef}..HEAD`], signal);
    const nameOut = await git(h.path, ["diff", "--name-only", `${h.baseRef}..HEAD`], signal);
    const files = nameOut
      .split("\n")
      .map((f) => f.trim())
      .filter(Boolean);
    return { changed: true, patch, files };
  } catch {
    return { changed: false, patch: "", files: [] };
  }
}

/**
 * Remove a worktree (and, unless `keepBranch`, its temp branch). Best-effort —
 * never throws, so cleanup in a `finally` can't mask the real error.
 */
export async function removeWorktree(
  h: WorktreeHandle,
  repoCwd: string,
  opts?: { keepBranch?: boolean },
): Promise<void> {
  let root = repoCwd;
  try {
    root = await gitRoot(repoCwd);
  } catch {
    // Use repoCwd as-is if we can't resolve the root.
  }
  try {
    await git(root, ["worktree", "remove", "--force", h.path]);
  } catch {
    // Locked files / already gone — the prune sweep will reconcile.
  }
  if (!opts?.keepBranch) {
    try {
      await git(root, ["branch", "-D", h.branch]);
    } catch {
      // Branch may not exist or be checked out elsewhere; ignore.
    }
  }
}

/** `git worktree prune` — sweep stale worktree registrations. Never throws. */
export async function pruneWorktrees(repoCwd: string): Promise<void> {
  try {
    const root = await gitRoot(repoCwd);
    await git(root, ["worktree", "prune"]);
  } catch {
    // Not a repo / git missing — nothing to prune.
  }
}
