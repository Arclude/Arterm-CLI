import { createHash } from "node:crypto";
import { promises as fs, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { ARTERM_HOME } from "./config.js";

/**
 * Persistent, project-scoped memory — Arterm's in-process equivalent of the
 * claude-mem pipeline. Tool activity captured during a session is digested into
 * compact "learning" records, persisted here, and replayed into the next
 * session's system prompt (see `memoryCapture.ts` and the agent's `recall` hook).
 */

/** A raw, in-flight observation buffered during a session (never persisted as-is). */
export interface Observation {
  /** Where it came from: a tool result, the user's goal, or the agent's note. */
  source: "tool" | "user" | "assistant";
  /** Short label, e.g. the tool name or "goal". */
  label: string;
  /** Trimmed text of the activity. */
  text: string;
}

/** Kind of persisted record. v1 only persists compressed learnings. */
export type MemoryKind = "learning";

/** Coarse classification of a learning, mirroring claude-mem's typed observations. */
export type LearningType = "feature" | "bugfix" | "decision" | "discovery" | "note";

/** One compressed, persisted memory entry. */
export interface MemoryRecord {
  id: string;
  kind: MemoryKind;
  /** Epoch milliseconds the record was written. */
  ts: number;
  type: LearningType;
  /** One-line summary (the part injected into the next session). */
  title: string;
  /** Optional detail, surfaced by `memory_search`. */
  body?: string;
  /** Files this learning touched or referenced (relative paths). */
  files?: string[];
}

/**
 * Project-scoped persistence for memory records. Selected via config
 * (see `memoryRegistry.ts`). The default is `NullMemoryStore` — nothing on disk.
 */
export interface MemoryStore {
  readonly id: string;
  /** Append one record. Best-effort; never throws. */
  append(record: MemoryRecord): Promise<void>;
  /** The most recent `limit` records, newest last (chronological). */
  recent(limit: number): Promise<MemoryRecord[]>;
  /** Every record, oldest first. */
  all(): Promise<MemoryRecord[]>;
  /**
   * Delete the record with exactly this id; true when one was removed.
   *
   * Optional because a store can legitimately be unable to forget — the
   * cross-project view in `mcpMemoryServer.ts` reads another project's file and
   * has no business deleting from it. A caller that finds this absent must say
   * so rather than report a deletion that never happened.
   *
   * Unlike `append`, this may THROW. `append` swallows I/O errors because a
   * session must not die over a memory write, but a swallowed failure here
   * would tell the user a fact is gone while it is still on disk, which is the
   * one lie this call must never tell.
   */
  remove?(id: string): Promise<boolean>;
}

/** Stores nothing. Used when memory is turned off. */
export class NullMemoryStore implements MemoryStore {
  readonly id = "off";
  async append(_record: MemoryRecord): Promise<void> {}
  async recent(_limit: number): Promise<MemoryRecord[]> {
    return [];
  }
  async all(): Promise<MemoryRecord[]> {
    return [];
  }
  async remove(_id: string): Promise<boolean> {
    return false;
  }
}

/**
 * Resolve the enclosing git repo root by walking up from `cwd` until a `.git`
 * entry is found (a directory for a normal repo, or a file for a worktree/submodule);
 * falls back to `cwd` when none exists. This scopes memory to the whole repo rather
 * than each subdirectory, so launching `arterm` from any folder inside a project
 * (e.g. `packages/cli`) sees the same project memory — claude-mem-style.
 */
export function repoRootOf(cwd: string): string {
  let dir = cwd;
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return cwd;
    dir = parent;
  }
}

/** Stable per-project key from a working directory (matches across sessions). */
export function projectKey(cwd: string): string {
  return createHash("sha1").update(repoRootOf(cwd)).digest("hex").slice(0, 16);
}

/** Directory holding all project memory files. */
export const MEMORY_DIR = join(ARTERM_HOME, "memory");
/** Maps each projectKey back to its human-readable cwd (for the viewer). */
export const MEMORY_INDEX = join(MEMORY_DIR, "index.json");

/** Parse JSONL text into records, skipping blank/corrupt lines. */
function parseRecords(raw: string): MemoryRecord[] {
  const records: MemoryRecord[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed) as MemoryRecord);
    } catch {
      // Skip corrupt lines rather than failing the whole read.
    }
  }
  return records;
}

/** Read and parse a project's JSONL file; [] if missing. */
async function readRecordsFile(path: string): Promise<MemoryRecord[]> {
  try {
    return parseRecords(await fs.readFile(path, "utf8"));
  } catch {
    return [];
  }
}

/**
 * Rewrite a project's file with exactly `records`, via a sibling temp file and a
 * rename.
 *
 * The rename is what makes it safe: truncating the real file and writing it back
 * leaves a project's entire memory empty if the process dies in between, and
 * this file is the only copy — there is no checkpoint and no git history behind
 * it. The temp file is a sibling so the rename stays within one filesystem,
 * where it is atomic.
 */
async function rewriteRecordsFile(path: string, records: MemoryRecord[]): Promise<void> {
  const tmp = `${path}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  await fs.writeFile(tmp, records.map((r) => `${JSON.stringify(r)}\n`).join(""), "utf8");
  await fs.rename(tmp, path);
}

/**
 * Append-only JSONL memory: one `{projectKey}.jsonl` per project under
 * `~/.arterm/memory/`. One record per line. Reads tolerate malformed lines.
 */
export class JsonlMemoryStore implements MemoryStore {
  readonly id = "jsonl";
  private readonly path: string;
  private indexed = false;

  constructor(
    private readonly cwd: string,
    private readonly dir: string = MEMORY_DIR,
  ) {
    this.path = join(dir, `${projectKey(cwd)}.jsonl`);
  }

  async append(record: MemoryRecord): Promise<void> {
    try {
      await fs.mkdir(this.dir, { recursive: true });
      await fs.appendFile(this.path, `${JSON.stringify(record)}\n`, "utf8");
      if (!this.indexed) {
        await registerProject(this.cwd, record.ts, this.dir);
        this.indexed = true;
      }
    } catch {
      // Memory writes must never break a session.
    }
  }

  async all(): Promise<MemoryRecord[]> {
    return readRecordsFile(this.path);
  }

  async recent(limit: number): Promise<MemoryRecord[]> {
    const all = await this.all();
    return limit > 0 ? all.slice(-limit) : all;
  }

  /**
   * Deletion in an append-only file is a rewrite of the whole file without the
   * line — there is nowhere else to record the absence. A tombstone record would
   * have been cheaper and race-free, but it leaves the forgotten text sitting in
   * `~/.arterm/memory/*.jsonl`, and "forget this" is most often asked about
   * something that should never have been written down.
   *
   * The read-then-rewrite is not atomic against a SECOND session appending to
   * the same project in the window between them: that record is lost. Accepted
   * over a lock file, because the window is one file read wide and two Arterm
   * sessions writing the same project's memory in that instant is rarer than the
   * bugs a lock protocol would add. Errors propagate — see `MemoryStore.remove`.
   */
  async remove(id: string): Promise<boolean> {
    const all = await this.all();
    const kept = all.filter((r) => r.id !== id);
    if (kept.length === all.length) return false;
    await rewriteRecordsFile(this.path, kept);
    return true;
  }
}

/** One entry in the project index: which directory a memory file belongs to. */
export interface ProjectInfo {
  key: string;
  cwd: string;
  updatedAt: number;
}

type ProjectIndex = Record<string, { cwd: string; updatedAt: number }>;

async function readIndex(dir: string): Promise<ProjectIndex> {
  try {
    return JSON.parse(await fs.readFile(join(dir, "index.json"), "utf8")) as ProjectIndex;
  } catch {
    return {};
  }
}

/** Record (or refresh) the cwd↔projectKey mapping so the viewer can name projects. */
export async function registerProject(
  cwd: string,
  updatedAt: number,
  dir: string = MEMORY_DIR,
): Promise<void> {
  try {
    await fs.mkdir(dir, { recursive: true });
    const index = await readIndex(dir);
    index[projectKey(cwd)] = { cwd: repoRootOf(cwd), updatedAt };
    await fs.writeFile(join(dir, "index.json"), `${JSON.stringify(index, null, 2)}\n`, "utf8");
  } catch {
    // Indexing is best-effort; memory still works without it.
  }
}

/** All known projects with memory, newest-updated first. */
export async function listMemoryProjects(dir: string = MEMORY_DIR): Promise<ProjectInfo[]> {
  const index = await readIndex(dir);
  return Object.entries(index)
    .map(([key, v]) => ({ key, cwd: v.cwd, updatedAt: v.updatedAt }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Read a project's records by its key (used by the viewer). */
export async function readProjectRecords(
  key: string,
  dir: string = MEMORY_DIR,
): Promise<MemoryRecord[]> {
  return readRecordsFile(join(dir, `${key}.jsonl`));
}
