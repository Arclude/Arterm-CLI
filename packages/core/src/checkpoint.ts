import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { ARTERM_HOME } from "./config.js";
import { projectKey } from "./memory.js";

/**
 * Checkpoint / rewind: undo what the agent wrote, per turn.
 *
 * Deliberately NOT a shadow git repo, which is how most agents implement this.
 * The published failure record of that approach is bad enough to disqualify it:
 * one agent renamed the user's root `.git` to `.git_disabled` when its
 * checkpoint init timed out and left version control severed, then recursed
 * into creating nested `.git` directories under `node_modules`; another scoped
 * its snapshot to the wrong directory so `/undo` reported success and restored
 * nothing — a silent no-op that reads as a working feature. A content-addressed
 * store costs about the same code and cannot fail those ways: it never touches
 * the user's index, HEAD, or `.git`, and it does not require a repository at
 * all.
 *
 * What is NOT restorable is as important as what is, and the caller must say so
 * out loud:
 *   1. Anything `bash` did (`rm`, `mv`, `sed -i`, migrations) — a shell command
 *      declares no paths, so nothing can be snapshotted ahead of it.
 *   2. Sub-agent edits under `fleet.isolation: "worktree"` — the worker writes
 *      in a different tree entirely, which this store never sees.
 *   3. Directory creation / deletion, and anything outside the workspace.
 *   4. Symlinked and hard-linked paths: skipped on restore, and counted, after
 *      a shipped agent silently wrote through them and corrupted dotfile
 *      managers and pnpm stores.
 *   5. Network and database side effects.
 */

/** One file's before/after content hashes within a checkpoint. */
export interface CheckpointEntry {
  /** Absolute path. */
  path: string;
  /** Content hash before the turn, or null when the turn created the file. */
  before: string | null;
  /** Content hash after the turn, or null when the turn deleted it. */
  after: string | null;
}

export interface Checkpoint {
  id: string;
  /** The user turn that produced it, clipped for the picker. */
  label: string;
  ts: number;
  entries: CheckpointEntry[];
}

export interface RestoreResult {
  /** Files written back. */
  restored: number;
  /** Files already matching the target content — left untouched. */
  unchanged: number;
  /**
   * Symlinks and hard-linked paths, skipped rather than written through.
   * Reported, never silent: the user has to know the restore was partial.
   */
  skippedLinks: number;
  /** Files the turn created and the restore therefore deleted. */
  deleted: number;
}

/** Files larger than this are not snapshotted (build artifacts, media). */
const MAX_FILE_BYTES = 2 * 1024 * 1024;
/** Checkpoints kept per session — two independent implementations chose 50. */
const MAX_CHECKPOINTS = 50;
/** Sessions older than this are pruned at startup. */
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** Label length in the picker. */
const LABEL_MAX = 72;

function hashOf(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * A per-project checkpoint store.
 *
 * Turn-granular on purpose: one checkpoint per user turn, labelled with the
 * prompt. Per-tool-call granularity produces a list no human can navigate, and
 * "undo what I just asked for" is the operation people actually want.
 */
export class CheckpointStore {
  private readonly root: string;
  private readonly objects: string;
  private turn: { label: string; entries: Map<string, string | null> } | undefined;
  /** Set by `restore` so a redo can go forward again. */
  private redoId: string | undefined;

  constructor(
    cwd: string,
    private readonly sessionId: string,
    home: string = ARTERM_HOME,
  ) {
    this.root = join(home, "checkpoints", projectKey(cwd));
    this.objects = join(this.root, "objects");
  }

  private get manifest(): string {
    return join(this.root, "sessions", `${this.sessionId}.jsonl`);
  }

  /**
   * Begin (or continue) a turn. Idempotent within a turn so a re-entrant call
   * never splits one prompt across two checkpoints.
   */
  beginTurn(label: string): void {
    if (this.turn) return;
    this.turn = { label: label.trim().slice(0, LABEL_MAX), entries: new Map() };
  }

  /**
   * Record the pre-write state of `paths`. Called from a `toolCall` stage
   * BEFORE the tool executes, with the paths that tool declares — which is why
   * only path-taking tools are covered and `bash` is not.
   *
   * First write wins: a path snapshotted earlier in the turn keeps its original
   * content, so restoring lands on the state before the whole turn rather than
   * before its last edit.
   */
  async capture(paths: string[]): Promise<void> {
    if (!this.turn) return;
    for (const p of paths) {
      const abs = isAbsolute(p) ? p : resolve(p);
      if (this.turn.entries.has(abs)) continue;
      this.turn.entries.set(abs, await this.store(abs));
    }
  }

  /**
   * Read a file and store it as a content-addressed object, returning its hash.
   * Returns null for a path that does not exist (the turn is creating it),
   * is too large, or is a link — the same exclusions restore honors.
   */
  private async store(abs: string): Promise<string | null> {
    try {
      const st = await fs.lstat(abs);
      if (!st.isFile() || st.isSymbolicLink() || st.nlink > 1) return null;
      if (st.size > MAX_FILE_BYTES) return null;
      const data = await fs.readFile(abs);
      const hash = hashOf(data);
      const dest = join(this.objects, hash.slice(0, 2), hash.slice(2));
      try {
        await fs.access(dest);
      } catch {
        await fs.mkdir(dirname(dest), { recursive: true });
        // Objects hold file contents verbatim, secrets included — same
        // treatment as a session transcript.
        await fs.writeFile(dest, data, { mode: 0o600 });
      }
      return hash;
    } catch {
      return null;
    }
  }

  /**
   * Close the turn, writing a checkpoint when anything actually changed.
   *
   * The no-change case is dropped rather than recorded: a turn that only read
   * files would otherwise fill the picker with entries that restore nothing.
   */
  async commitTurn(): Promise<Checkpoint | undefined> {
    const turn = this.turn;
    this.turn = undefined;
    if (!turn || turn.entries.size === 0) return undefined;

    const entries: CheckpointEntry[] = [];
    for (const [path, before] of turn.entries) {
      const after = await this.store(path);
      if (before === after) continue; // untouched after all
      entries.push({ path, before, after });
    }
    if (entries.length === 0) return undefined;

    const cp = await this.write(turn.label, entries);
    // A new turn's work invalidates any forward history.
    this.redoId = undefined;
    return cp;
  }

  /** Append one checkpoint to the session manifest. */
  private async write(label: string, entries: CheckpointEntry[]): Promise<Checkpoint> {
    const cp: Checkpoint = {
      id: `cp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      label,
      ts: Date.now(),
      entries,
    };
    await fs.mkdir(dirname(this.manifest), { recursive: true });
    await fs.appendFile(this.manifest, `${JSON.stringify(cp)}\n`, "utf8");
    return cp;
  }

  /** Checkpoints for this session, newest last. */
  async list(): Promise<Checkpoint[]> {
    try {
      const raw = await fs.readFile(this.manifest, "utf8");
      const all = raw
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Checkpoint);
      return all.slice(-MAX_CHECKPOINTS);
    } catch {
      return [];
    }
  }

  /**
   * Restore the working tree to the state BEFORE checkpoint `id` (and every
   * checkpoint after it), then record the pre-restore state so the move can be
   * undone.
   *
   * Only paths whose current content differs are written: rewriting identical
   * files would destroy mtimes and trigger editor "changed on disk" prompts
   * and full rebuilds, which is a real complaint against a shipped
   * implementation.
   */
  async restore(id: string): Promise<RestoreResult> {
    const all = await this.list();
    const idx = all.findIndex((c) => c.id === id);
    if (idx === -1) throw new Error(`no such checkpoint: ${id}`);

    // Newest-first so the OLDEST recorded `before` for a path wins.
    const target = new Map<string, string | null>();
    for (const cp of all.slice(idx).reverse()) {
      for (const e of cp.entries) target.set(e.path, e.before);
    }

    // Record the rewind itself as a checkpoint — before: where the tree is
    // now, after: where this restore is about to put it. Redo is then just
    // another restore, with no second stack that can fall out of sync with the
    // first (desynchronized redo stacks are where a shipped implementation's
    // history-corrupting bugs live). Written directly rather than through
    // `commitTurn`, whose "nothing changed, drop it" rule is right for a turn
    // and wrong for a snapshot: here before and after are equal by
    // construction for any file the restore leaves alone.
    const undoEntries: CheckpointEntry[] = [];
    for (const [path, hash] of target) {
      undoEntries.push({ path, before: await this.store(path), after: hash });
    }
    this.redoId = (await this.write(`before rewind to "${all[idx]?.label ?? id}"`, undoEntries)).id;

    const out: RestoreResult = { restored: 0, unchanged: 0, skippedLinks: 0, deleted: 0 };
    for (const [path, hash] of target) {
      // Never write through a link: the target may be a dotfile manager's real
      // file or a package store's shared inode.
      try {
        const st = await fs.lstat(path);
        if (st.isSymbolicLink() || st.nlink > 1) {
          out.skippedLinks += 1;
          continue;
        }
        if (hash === null) {
          // The turn created this file; undoing means removing it.
          await fs.rm(path, { force: true });
          out.deleted += 1;
          continue;
        }
        if (hashOf(await fs.readFile(path)) === hash) {
          out.unchanged += 1;
          continue;
        }
      } catch {
        // Missing now: fall through and write it back (unless it should stay gone).
        if (hash === null) continue;
      }
      const obj = join(this.objects, hash.slice(0, 2), hash.slice(2));
      const data = await fs.readFile(obj);
      await fs.mkdir(dirname(path), { recursive: true });
      await fs.writeFile(path, data);
      out.restored += 1;
    }
    return out;
  }

  /** The checkpoint a redo would restore, when a rewind just happened. */
  get redoTarget(): string | undefined {
    return this.redoId;
  }

  /**
   * Drop sessions older than 30 days and collect objects nothing references.
   * Returns what it removed — pruning silently is its own bug class: users of
   * another agent watched checkpoints vanish with no notice and no recovery.
   */
  async prune(now = Date.now()): Promise<{ sessions: number; objects: number }> {
    const dir = join(this.root, "sessions");
    let sessions = 0;
    const live = new Set<string>();
    let names: string[] = [];
    try {
      names = await fs.readdir(dir);
    } catch {
      return { sessions: 0, objects: 0 };
    }
    for (const name of names) {
      const file = join(dir, name);
      const st = await fs.stat(file).catch(() => undefined);
      if (st && now - st.mtimeMs > MAX_AGE_MS) {
        await fs.rm(file, { force: true });
        sessions += 1;
        continue;
      }
      const raw = await fs.readFile(file, "utf8").catch(() => "");
      for (const line of raw.split("\n").filter(Boolean)) {
        try {
          for (const e of (JSON.parse(line) as Checkpoint).entries) {
            if (e.before) live.add(e.before);
            if (e.after) live.add(e.after);
          }
        } catch {
          // A truncated last line (crash mid-append) is not a reason to abort.
        }
      }
    }
    let objects = 0;
    const shards = await fs.readdir(this.objects).catch(() => [] as string[]);
    for (const shard of shards) {
      const files = await fs.readdir(join(this.objects, shard)).catch(() => [] as string[]);
      for (const f of files) {
        if (live.has(shard + f)) continue;
        await fs.rm(join(this.objects, shard, f), { force: true });
        objects += 1;
      }
    }
    return { sessions, objects };
  }
}

/**
 * The paths a tool call is about to write, as far as the call declares them.
 *
 * Argument-driven rather than tool-name-driven where possible, but the mapping
 * is explicit: guessing "any string that looks like a path" would snapshot
 * grep patterns and command lines. A tool that declares nothing (notably
 * `bash`) yields nothing — that gap is documented, not papered over.
 */
export function declaredPaths(name: string, args: Record<string, unknown>): string[] {
  const one = (v: unknown): string[] => (typeof v === "string" && v.trim() ? [v] : []);
  switch (name) {
    case "write":
    case "edit":
    case "multi_edit":
    case "apply_patch":
      return one(args.path);
    default:
      return [];
  }
}
