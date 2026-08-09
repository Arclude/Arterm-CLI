/**
 * What a SHELL command changed, measured instead of declared.
 *
 * The chronicle records `ToolResult.path` and `.diff`, which the writing tools
 * produce — and `mutatingDiff.test.ts` forces every one of them to. `bash`
 * declares neither, because it cannot: the tool runs a string and has no idea
 * what the string touched. So the ledger's own documented hole was that a file
 * written by `sed -i`, `>`, `git apply` or `npm init` is invisible to it, and
 * the judge reads that ledger AGAINST the claim. An autonomous run doing all
 * its work through the shell produced an empty evidence block, which is exactly
 * the state the judge treats as "this run wrote nothing" — the reading that let
 * a rewritten `slug()` pass as `docs(…)`.
 *
 * The rule the rest of the ledger lives by does not bend here: a record must
 * not be composed by a model. So this does NOT parse the command. The command
 * is model output, and a path read out of it is the story again, in a costume —
 * `sh -c 'x=out.txt; printf … > $x'` names nothing at all, and a command that
 * mentions a file it never wrote would be recorded as having written it. What
 * is measured is the TREE: a digest of every candidate file before the call and
 * after it, read off the disk both times, and only the ones that actually moved
 * are recorded.
 *
 * Git is the candidate set, and that is the scope limit worth stating plainly:
 * outside a repository there is no watcher, and inside one a `.gitignore`d path
 * is not watched either. Both are deliberate. The alternative — walking the
 * write roots — costs a `node_modules` scan on every shell call to catch build
 * output that is not evidence of anything. What IS covered is the case the hole
 * was about: source files, tracked or untracked, that a command changed.
 *
 * A change here is weaker evidence than a tool-declared one and says so
 * (`attributes.observedBy: "git"` on the record). It cannot prove the COMMAND
 * made the change — a watcher and a `before`/`after` pair see anything that
 * moved in between, including a build daemon — while an `edit` result is the
 * tool's own account of its own write. Weaker is not weightless: the judge's
 * stated uses are presence and absence ("a file the claim never mentions, one
 * it says it changed that is absent"), and both survive the distinction.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ChronicleChange } from "./chronicle.js";

const run = promisify(execFile);
const GIT_OPTS = { windowsHide: true, maxBuffer: 32 * 1024 * 1024 } as const;

/**
 * How many candidate files one snapshot will digest.
 *
 * A bound rather than a guess: the candidates are the dirty set, so a tree with
 * a thousand uncommitted files would otherwise pay a thousand file reads on
 * every shell call. When it binds, the fact is recorded (`observedTruncated`)
 * rather than silently dropped — the rule `roundClaim` and `evidenceBlock`
 * already follow, because a list that quietly stops reads as a complete one.
 */
export const MAX_WATCHED_FILES = 200;

/**
 * The largest file this will read to digest it.
 *
 * Past it the file is skipped and counted, not partially hashed: a digest over
 * the first N bytes is a different value wearing the same field name, and a
 * ledger whose digests mean two things cannot be checked at all. Anything this
 * size in a source tree is a build artifact, and those are usually ignored and
 * therefore never candidates in the first place.
 */
const MAX_WATCHED_BYTES = 4 * 1024 * 1024;

/** A file's measured state: what it hashes to, and how many lines it holds. */
interface FileState {
  hash: string;
  lines: number;
}

/** The tree as it stood, against which the next look is compared. */
export interface WorkspaceSnapshot {
  /** Absolute repo root the paths below are relative to. */
  root: string;
  /**
   * Every candidate path git named, readable or not.
   *
   * Kept beside `states` rather than derived from it, because the two differ
   * exactly where it matters: a DELETED file is a candidate with no state, and
   * a set built only from what could be read cannot see one. `rm` was invisible
   * until this was its own field.
   */
  paths: Set<string>;
  /** Candidate path (repo-relative) → its state, for files that could be read. */
  states: Map<string, FileState>;
  /** Per-path line counts against HEAD, for the tracked files git can diff. */
  numstat: Map<string, { added: number; removed: number }>;
  /** Paths a bound kept out — excluded from the comparison, never called gone. */
  skippedPaths: Set<string>;
  /** How many candidates that was. */
  skipped: number;
}

/** What changed between two looks at the tree, plus what was not looked at. */
export interface WorkspaceChanges {
  changes: ChronicleChange[];
  /** Files the bounds kept out of the comparison, on either side. */
  skipped: number;
}

/**
 * The seam. `chronicleToolCall` takes one of these rather than calling git
 * directly, so the stage is testable with a fake that returns a fixed tree and
 * the process-spawning half stays in this file.
 */
export interface WorkspaceWatcher {
  /** The tree before a call, or undefined where there is nothing to watch. */
  snapshot(cwd: string, signal?: AbortSignal): Promise<WorkspaceSnapshot | undefined>;
  /** What moved since. Never throws — a watcher that fails observes nothing. */
  changesSince(
    before: WorkspaceSnapshot,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<WorkspaceChanges>;
}

async function git(cwd: string, args: string[], signal?: AbortSignal): Promise<string> {
  const { stdout } = await run("git", args, { ...GIT_OPTS, cwd, signal });
  return stdout;
}

/**
 * Candidate paths: everything git does not consider clean.
 *
 * `-uall` rather than the default, because the default collapses a new
 * directory to `newdir/` and the file inside it is what a command wrote.
 * `-z` because a path may contain a space or a newline, and git quotes those in
 * the human format — parsing quoted paths back is a bug waiting to be reported
 * as "the ledger missed my file".
 */
async function candidates(root: string, signal?: AbortSignal): Promise<string[]> {
  const out = await git(root, ["status", "--porcelain=v1", "-uall", "-z"], signal);
  const paths: string[] = [];
  // -z gives NUL-terminated entries of the form `XY <path>`, and a rename adds
  // the ORIGINAL path as its own entry after the new one. Both sides matter: a
  // rename removes one file and creates another.
  const entries = out.split("\0").filter((e) => e.length > 0);
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i] ?? "";
    const status = entry.slice(0, 2);
    const path = entry.slice(3);
    if (path) paths.push(path);
    if (status.includes("R") || status.includes("C")) {
      // The source path follows as the next NUL-terminated field, unprefixed.
      const source = entries[++i];
      if (source) paths.push(source);
    }
  }
  return paths;
}

/** Line counts against HEAD for tracked files, in one call. Binary files omitted. */
async function numstat(
  root: string,
  signal?: AbortSignal,
): Promise<Map<string, { added: number; removed: number }>> {
  const map = new Map<string, { added: number; removed: number }>();
  let out: string;
  try {
    out = await git(root, ["diff", "--numstat", "-z", "HEAD"], signal);
  } catch {
    // No HEAD yet (a repo before its first commit) — every file is untracked,
    // and the creation path below counts those from their own contents.
    return map;
  }
  const fields = out.split("\0").filter((f) => f.length > 0);
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i] ?? "";
    const m = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(field);
    if (!m) continue;
    // A rename in `-z` puts the two paths in the two fields that follow.
    let path = m[3] ?? "";
    if (path === "") {
      i += 1;
      path = fields[++i] ?? "";
    }
    if (m[1] === "-" || m[2] === "-") continue; // binary: git reports no counts
    map.set(path, { added: Number(m[1]), removed: Number(m[2]) });
  }
  return map;
}

/** Digest a file and count its lines in one read, or undefined if unreadable. */
async function measure(absolute: string): Promise<FileState | undefined> {
  try {
    const info = await stat(absolute);
    if (!info.isFile() || info.size > MAX_WATCHED_BYTES) return undefined;
    const bytes = await readFile(absolute);
    let lines = 0;
    for (const b of bytes) if (b === 0x0a) lines++;
    if (bytes.length > 0 && bytes[bytes.length - 1] !== 0x0a) lines++;
    return { hash: createHash("sha256").update(bytes).digest("hex"), lines };
  } catch {
    return undefined;
  }
}

/** The watcher backed by git. Every failure degrades to "observed nothing". */
export function gitWorkspaceWatcher(): WorkspaceWatcher {
  const roots = new Map<string, string | undefined>();

  /** Repo root for a cwd, memoized — a session's cwd rarely moves. */
  async function rootOf(cwd: string, signal?: AbortSignal): Promise<string | undefined> {
    const cached = roots.get(cwd);
    if (cached !== undefined || roots.has(cwd)) return cached;
    let root: string | undefined;
    try {
      root = (await git(cwd, ["rev-parse", "--show-toplevel"], signal)).trim() || undefined;
    } catch {
      root = undefined;
    }
    roots.set(cwd, root);
    return root;
  }

  async function look(
    root: string,
    signal?: AbortSignal,
  ): Promise<Omit<WorkspaceSnapshot, "root">> {
    const all = [...new Set(await candidates(root, signal))];
    const watched = all.slice(0, MAX_WATCHED_FILES);
    const skippedPaths = new Set(all.slice(MAX_WATCHED_FILES));
    const states = new Map<string, FileState>();
    const measured = await Promise.all(watched.map((p) => measure(join(root, p))));
    for (const [i, state] of measured.entries()) {
      const path = watched[i];
      if (!path) continue;
      if (state) {
        states.set(path, state);
        continue;
      }
      // Unreadable is two different facts. A path git still lists with no file
      // behind it is a DELETION, and its absence from `states` is what records
      // it as one. A file too large to digest is not gone and must never be
      // reported as gone — so it leaves the comparison entirely.
      try {
        const info = await stat(join(root, path));
        if (info.isFile() && info.size > MAX_WATCHED_BYTES) skippedPaths.add(path);
      } catch {
        // Genuinely absent. Left in `paths`, absent from `states`: a deletion.
      }
    }
    return {
      paths: new Set(all),
      states,
      numstat: await numstat(root, signal),
      skippedPaths,
      skipped: skippedPaths.size,
    };
  }

  return {
    async snapshot(cwd, signal) {
      const root = await rootOf(cwd, signal);
      if (!root) return undefined;
      try {
        return { root, ...(await look(root, signal)) };
      } catch {
        return undefined;
      }
    },

    async changesSince(before, cwd, signal) {
      let after: Omit<WorkspaceSnapshot, "root">;
      try {
        after = await look(before.root, signal);
      } catch {
        return { changes: [], skipped: before.skipped };
      }
      const changes: ChronicleChange[] = [];
      for (const path of new Set([...before.paths, ...after.paths])) {
        if (before.skippedPaths.has(path) || after.skippedPaths.has(path)) continue;
        const was = before.states.get(path);
        // A path git no longer lists went CLEAN during the call — `git checkout
        // -- file` is a change like any other, and the after-look never saw it
        // because a restored file is not a candidate. Measured here or it would
        // read as "nothing happened", which is the failure mode being fixed.
        const now = after.paths.has(path)
          ? after.states.get(path)
          : await measure(join(before.root, path));
        // No state on either side is TWO cases, and only one is a non-event. A
        // file already gone before the call is still gone: nothing happened. A
        // file that was CLEAN before — and so was never a candidate, and so has
        // no before-state — and is now listed as deleted was deleted by this
        // call, which is the `rm` the ledger must not miss.
        if (!now && !was && before.paths.has(path)) continue;
        if (was && now && was.hash === now.hash) continue;
        changes.push({
          path,
          ...counts(path, was, now, before.numstat, after.numstat),
          ...(now ? { contentHashAfter: now.hash } : {}),
        });
      }
      // Stable order so two runs over the same work read the same, and a
      // reviewer comparing two ledgers is comparing the work and not the order
      // the filesystem happened to answer in.
      changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      return { changes, skipped: before.skipped + after.skipped };
    },
  };
}

/**
 * How much of the file moved.
 *
 * Three cases, and the third is the honest one. A tracked file has counts on
 * both sides, so the DELTA is this call's contribution — measuring against HEAD
 * instead would credit a shell command with every earlier edit to the same
 * file, which is precisely the misattribution the ledger exists to prevent. A
 * file that did not exist before is all addition, counted from the bytes just
 * read. Anything else — an untracked file edited again, a revert, a binary git
 * reports no counts for — is recorded as `0/0`, which `evidenceBlock` renders
 * as "changed" rather than as "+0/-0": the digest already proves it moved, and
 * inventing a number for it would be the story again.
 */
function counts(
  path: string,
  was: FileState | undefined,
  now: FileState | undefined,
  before: Map<string, { added: number; removed: number }>,
  after: Map<string, { added: number; removed: number }>,
): { added: number; removed: number } {
  const b = before.get(path);
  const a = after.get(path);
  if (b && a) {
    return { added: Math.max(0, a.added - b.added), removed: Math.max(0, a.removed - b.removed) };
  }
  if (!was && now) return { added: a ? a.added : now.lines, removed: 0 };
  return { added: 0, removed: 0 };
}
