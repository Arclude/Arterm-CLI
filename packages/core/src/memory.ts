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
