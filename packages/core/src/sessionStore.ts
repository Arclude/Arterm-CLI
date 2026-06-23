import { promises as fs } from "node:fs";
import { SESSIONS_DIR, SessionLog, type SessionSummary, listSessions } from "./sessions.js";
import type { Message } from "./types.js";

/** A live, write-only handle to one recorded session. */
export interface SessionHandle {
  readonly id: string;
  logMessage(message: Message): Promise<void>;
}

/** How aggressively to trim old sessions on startup. */
export interface RetentionPolicy {
  /** Keep at most this many most-recent sessions (undefined = unlimited). */
  maxSessions?: number;
  /** Delete sessions older than this many days (undefined = no age cap). */
  maxAgeDays?: number;
}

/**
 * Pluggable persistence backend for conversation transcripts. Selected via config
 * (see `storeRegistry.ts`). The default is `NullSessionStore` — nothing on disk.
 */
export interface SessionStore {
  readonly id: string;
  create(meta: { model: string; provider: string }): Promise<SessionHandle>;
  list(): Promise<SessionSummary[]>;
  /** Delete sessions per policy; returns the removed ids. Best-effort, never throws. */
  prune(policy: RetentionPolicy): Promise<string[]>;
}

/** Stores nothing. Used when session logging is turned off (the default). */
export class NullSessionStore implements SessionStore {
  readonly id = "off";

  async create(_meta?: { model: string; provider: string }): Promise<SessionHandle> {
    const { randomUUID } = await import("node:crypto");
    const id = randomUUID();
    return { id, logMessage: async () => {} };
  }

  async list(): Promise<SessionSummary[]> {
    return [];
  }

  async prune(_policy?: RetentionPolicy): Promise<string[]> {
    return [];
  }
}

const DAY_MS = 86_400_000;

/** Append-only JSONL store: one `{id}.jsonl` per session under `dir`. */
export class JsonlSessionStore implements SessionStore {
  readonly id = "jsonl";
  constructor(private readonly dir: string = SESSIONS_DIR) {}

  async create(meta: { model: string; provider: string }): Promise<SessionHandle> {
    return SessionLog.create(meta, this.dir);
  }

  list(): Promise<SessionSummary[]> {
    return listSessions(this.dir);
  }

  async prune(policy: RetentionPolicy): Promise<string[]> {
    if (policy.maxSessions === undefined && policy.maxAgeDays === undefined) return [];

    const summaries = await listSessions(this.dir);
    const entries: { id: string; path: string; mtime: number }[] = [];
    for (const s of summaries) {
      if (!s.path) continue;
      try {
        const stat = await fs.stat(s.path);
        entries.push({ id: s.id, path: s.path, mtime: stat.mtimeMs });
      } catch {
        // Skip files that vanished or can't be stat'd.
      }
    }
    entries.sort((a, b) => b.mtime - a.mtime); // newest first

    const now = Date.now();
    const removed: string[] = [];
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i] as (typeof entries)[number];
      const tooOld = policy.maxAgeDays !== undefined && now - e.mtime > policy.maxAgeDays * DAY_MS;
      const overCount = policy.maxSessions !== undefined && i >= policy.maxSessions;
      if (!tooOld && !overCount) continue;
      try {
        await fs.unlink(e.path);
        removed.push(e.id);
      } catch {
        // Best-effort; ignore failures.
      }
    }
    return removed;
  }
}
