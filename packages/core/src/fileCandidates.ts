/**
 * The files `@` completes over.
 *
 * Split from `mentions.ts` because the two answer different questions and fail
 * differently: this one LISTS what could be named and is allowed to come back
 * empty, while that one reads what WAS named and must explain itself when it
 * cannot. Keeping them apart is also what stops the completion's bounds from
 * being mistaken for the mention's — a file this never offers can still be
 * typed in full, and is read exactly the same way.
 *
 * Git is the candidate set where there is a repository, for `workspaceWatch.ts`'s
 * reason: it is the one index of "files that are part of this project" that
 * already exists, it is fast, and it applies `.gitignore` without this file
 * having to reimplement it. The scope limit is stated rather than hidden — a
 * `.gitignore`d file is not offered, though it can still be typed.
 *
 * Outside a repository there is a bounded walk instead of nothing, because a
 * terminal agent is used plenty of places that are not repositories (a home
 * directory, `/etc`, a scratch folder) and a picker that is empty there reads as
 * broken rather than as scoped. The walk is what makes the bounds necessary:
 * `MAX_CANDIDATES` and `MAX_WALK_DEPTH` exist so that opening the picker in `/`
 * costs a known amount, and `ALWAYS_SKIPPED` keeps `node_modules` out of a list
 * nobody wants it in.
 */

import { execFile } from "node:child_process";
import type { Dirent } from "node:fs";
import { promises as fs } from "node:fs";
import { join, relative, sep } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * How many paths the picker will hold.
 *
 * A ceiling on the LIST, not on the filter: the query narrows what is shown,
 * and a tree bigger than this is one where typing two more characters is faster
 * than scrolling anyway. It is deliberately generous enough that a repository
 * this size (~2k files) fits whole.
 */
export const MAX_CANDIDATES = 20_000;

/** How deep the non-git walk descends before it stops. */
export const MAX_WALK_DEPTH = 8;

/**
 * Never walked, whatever the directory.
 *
 * Shared in spirit with `tools/src/ignore.ts`'s `ALWAYS_IGNORED` rather than
 * imported from it: `core` may not depend on `tools`, and a list this short
 * spelled twice is a smaller cost than the dependency direction it would break.
 */
export const ALWAYS_SKIPPED = new Set([
  ".git",
  "node_modules",
  ".venv",
  "__pycache__",
  "dist",
  "target",
  ".next",
]);

/**
 * Every file that can be completed, relative to `cwd`, `/`-separated.
 *
 * Never throws and never rejects: a picker whose list failed to build shows
 * nothing, which is the same thing it shows in an empty directory, and neither
 * is a reason to interrupt someone's typing.
 */
export async function listCandidates(cwd: string, signal?: AbortSignal): Promise<string[]> {
  const tracked = await gitFiles(cwd, signal);
  if (tracked) return tracked;
  return walk(cwd, signal);
}

/**
 * Tracked plus untracked-but-not-ignored, or undefined outside a repository.
 *
 * `--others --exclude-standard` is what adds the file you created ten seconds
 * ago: listing only tracked files would leave a new file uncompletable until it
 * was committed, which is precisely when someone wants to point the model at it.
 */
async function gitFiles(cwd: string, signal?: AbortSignal): Promise<string[] | undefined> {
  try {
    const { stdout } = await run(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      { cwd, signal, windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
    );
    const files = stdout.split("\0").filter((f) => f.length > 0);
    return files.slice(0, MAX_CANDIDATES);
  } catch {
    // Not a repository, no git on PATH, or the call was aborted. All three mean
    // the same thing here: ask the filesystem instead.
    return undefined;
  }
}

/** Breadth-first so the shallow files — the ones people mean — are found first. */
async function walk(root: string, signal?: AbortSignal): Promise<string[]> {
  const out: string[] = [];
  let level = [root];
  for (let depth = 0; depth <= MAX_WALK_DEPTH && level.length > 0; depth += 1) {
    const next: string[] = [];
    for (const dir of level) {
      if (signal?.aborted || out.length >= MAX_CANDIDATES) return out;
      let entries: Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.name.startsWith(".") && entry.name !== ".env") continue;
        if (ALWAYS_SKIPPED.has(entry.name)) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) next.push(full);
        else if (entry.isFile()) {
          if (out.length >= MAX_CANDIDATES) return out;
          out.push(relative(root, full).split(sep).join("/"));
        }
      }
    }
    level = next;
  }
  return out;
}
