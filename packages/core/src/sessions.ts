import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { ARTERM_HOME } from "./config.js";
import type { Message } from "./types.js";

/** Directory holding one append-only JSONL file per session. */
export const SESSIONS_DIR = join(ARTERM_HOME, "sessions");

/** First line of every session file: provenance for the conversation. */
interface SessionMeta {
  kind: "meta";
  id: string;
  model: string;
  provider: string;
  startedAt: string;
}

/** Summary derived from a session file's meta line, used for listing. */
export interface SessionSummary {
  id: string;
  model?: string;
  provider?: string;
  startedAt?: string;
  path: string;
}

/**
 * Append-only JSONL log of a single chat session. The first line is a `meta`
 * record; subsequent lines are arbitrary entries (typically `message` records).
 */
export class SessionLog {
  private constructor(
    private readonly _id: string,
    private readonly _path: string,
  ) {}

  get id(): string {
    return this._id;
  }

  get path(): string {
    return this._path;
  }

  /** Create a new session file (with its meta line) under `dir`. */
  static async create(
    meta: { model: string; provider: string },
    dir: string = SESSIONS_DIR,
  ): Promise<SessionLog> {
    await fs.mkdir(dir, { recursive: true });
    const id = randomUUID();
    const path = join(dir, `${id}.jsonl`);
    const log = new SessionLog(id, path);
    const metaLine: SessionMeta = {
      kind: "meta",
      id,
      model: meta.model,
      provider: meta.provider,
      startedAt: new Date().toISOString(),
    };
    await log.append(metaLine);
    return log;
  }

  /** Append one JSON entry as a newline-terminated line. */
  async append(entry: object): Promise<void> {
    await fs.appendFile(this._path, `${JSON.stringify(entry)}\n`, "utf8");
  }

  /** Append a conversation message as a `message` record. */
  async logMessage(message: Message): Promise<void> {
    await this.append({ kind: "message", ...message });
  }
}

/**
 * List recorded sessions, newest-readable-first as the directory yields them.
 * Each summary comes from the file's first (meta) line; unreadable or malformed
 * files are skipped. Returns [] when no sessions dir exists yet.
 */
export async function listSessions(dir: string = SESSIONS_DIR): Promise<SessionSummary[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }

  const summaries: SessionSummary[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".jsonl")) continue;
    const path = join(dir, entry);
    try {
      const raw = await fs.readFile(path, "utf8");
      const firstLine = raw.split("\n", 1)[0] ?? "";
      const meta = JSON.parse(firstLine) as Partial<SessionMeta>;
      summaries.push({
        id: meta.id ?? entry.replace(/\.jsonl$/, ""),
        model: meta.model,
        provider: meta.provider,
        startedAt: meta.startedAt,
        path,
      });
    } catch {
      // Skip unreadable or malformed session files.
    }
  }
  return summaries;
}
