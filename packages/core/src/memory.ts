import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";
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

/** Stable per-project key from a working directory (matches across sessions). */
export function projectKey(cwd: string): string {
  return createHash("sha1").update(cwd).digest("hex").slice(0, 16);
}

/** Directory holding all project memory files. */
export const MEMORY_DIR = join(ARTERM_HOME, "memory");

/**
 * Append-only JSONL memory: one `{projectKey}.jsonl` per project under
 * `~/.arterm/memory/`. One record per line. Reads tolerate malformed lines.
 */
export class JsonlMemoryStore implements MemoryStore {
  readonly id = "jsonl";
  private readonly path: string;

  constructor(cwd: string, dir: string = MEMORY_DIR) {
    this.path = join(dir, `${projectKey(cwd)}.jsonl`);
  }

  async append(record: MemoryRecord): Promise<void> {
    try {
      await fs.mkdir(join(this.path, ".."), { recursive: true });
      await fs.appendFile(this.path, `${JSON.stringify(record)}\n`, "utf8");
    } catch {
      // Memory writes must never break a session.
    }
  }

  async all(): Promise<MemoryRecord[]> {
    let raw: string;
    try {
      raw = await fs.readFile(this.path, "utf8");
    } catch {
      return [];
    }
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

  async recent(limit: number): Promise<MemoryRecord[]> {
    const all = await this.all();
    return limit > 0 ? all.slice(-limit) : all;
  }
}
