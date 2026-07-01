import { promises as fs } from "node:fs";
import { join } from "node:path";
import {
  ARTERM_HOME,
  type ProjectInfo,
  listMemoryProjects,
  projectKey,
  registerProject,
} from "@arterm/core";
import type { Observation, ObservationInput } from "./types.js";

/**
 * Persistence for the rich observation store. Prefers `node:sqlite` (with an
 * FTS5 virtual table for fast lexical search) and falls back to a pure in-memory
 * map backed by best-effort JSONL when `node:sqlite` — or FTS5 specifically — is
 * unavailable. The `node:sqlite` lazy-import + null-fallback pattern mirrors
 * `@arterm/tools`' `symbolIndex.ts`. All writes are best-effort and never throw:
 * memory must never break a session.
 */

/** Directory holding the new-engine ("cmem") databases, kept separate from legacy memory. */
export const CMEM_DIR = join(ARTERM_HOME, "cmem");

const SCHEMA_VERSION = 1;

/** Backend-agnostic store surface used by the engine and tools. */
export interface MemStore {
  /** Which backend is live. */
  readonly id: "sqlite" | "memory";
  /** True when SQLite FTS5 is available; false → lexical search uses BM25. */
  readonly fts: boolean;
  /** Insert an observation; returns its new id, or null if a duplicate/failed. */
  put(obs: ObservationInput): Promise<number | null>;
  /** Fetch full observations by id (order by id asc; unknown ids skipped). */
  get(ids: number[]): Promise<Observation[]>;
  /** The most recent `limit` observations, newest last. */
  recent(limit: number): Promise<Observation[]>;
  /** Every observation, oldest first. */
  all(): Promise<Observation[]>;
  /** FTS5 lexical search → matching ids (empty when `fts` is false). */
  ftsSearch(query: string, limit: number): Promise<number[]>;
  /** Observations chronologically around an anchor id (inclusive of the anchor). */
  around(anchor: number, before: number, after: number): Promise<Observation[]>;
  /** True if an observation with this content hash already exists. */
  hasHash(hash: string): Promise<boolean>;
  /** Release any underlying handle. */
  close(): void;
}

// --- SQLite backend ---------------------------------------------------------

/** Minimal subset of the `node:sqlite` surface we rely on. */
interface SqliteStatement {
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}
interface SqliteDb {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  close(): void;
}

interface ObsRow {
  id: number;
  ts: number;
  project: string;
  type: string;
  title: string;
  subtitle: string | null;
  facts: string;
  narrative: string;
  concepts: string;
  files_read: string;
  files_modified: string;
  discovery_tokens: number;
  read_tokens: number;
  content_hash: string;
  embedding: Uint8Array | null;
}

const BASE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS observations (
    id             INTEGER PRIMARY KEY,
    ts             INTEGER NOT NULL,
    project        TEXT    NOT NULL,
    type           TEXT    NOT NULL,
    title          TEXT    NOT NULL,
    subtitle       TEXT,
    facts          TEXT    NOT NULL,
    narrative      TEXT    NOT NULL,
    concepts       TEXT    NOT NULL,
    files_read     TEXT    NOT NULL,
    files_modified TEXT    NOT NULL,
    discovery_tokens INTEGER NOT NULL,
    read_tokens    INTEGER NOT NULL,
    content_hash   TEXT    NOT NULL UNIQUE,
    embedding      BLOB
  );
  CREATE INDEX IF NOT EXISTS idx_obs_ts   ON observations (ts);
  CREATE INDEX IF NOT EXISTS idx_obs_hash ON observations (content_hash);
`;

const FTS_SCHEMA = `
  CREATE VIRTUAL TABLE IF NOT EXISTS obs_fts USING fts5(
    title, subtitle, facts, narrative, concepts,
    content='observations', content_rowid='id');
  CREATE TRIGGER IF NOT EXISTS obs_ai AFTER INSERT ON observations BEGIN
    INSERT INTO obs_fts(rowid, title, subtitle, facts, narrative, concepts)
    VALUES (new.id, new.title, new.subtitle, new.facts, new.narrative, new.concepts);
  END;
  CREATE TRIGGER IF NOT EXISTS obs_ad AFTER DELETE ON observations BEGIN
    INSERT INTO obs_fts(obs_fts, rowid, title, subtitle, facts, narrative, concepts)
    VALUES ('delete', old.id, old.title, old.subtitle, old.facts, old.narrative, old.concepts);
  END;
`;

const INSERT_SQL = `
  INSERT INTO observations
    (ts, project, type, title, subtitle, facts, narrative, concepts,
     files_read, files_modified, discovery_tokens, read_tokens, content_hash, embedding)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

function packEmbedding(vec: number[] | null | undefined): Uint8Array | null {
  if (!vec || vec.length === 0) return null;
  const f32 = Float32Array.from(vec);
  return new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength);
}

function unpackEmbedding(blob: Uint8Array | null): number[] | null {
  if (!blob || blob.byteLength < 4) return null;
  const f32 = new Float32Array(blob.buffer, blob.byteOffset, Math.floor(blob.byteLength / 4));
  return Array.from(f32);
}

function rowToObs(row: ObsRow): Observation {
  return {
    id: row.id,
    ts: row.ts,
    project: row.project,
    type: row.type as Observation["type"],
    title: row.title,
    ...(row.subtitle ? { subtitle: row.subtitle } : {}),
    facts: JSON.parse(row.facts) as string[],
    narrative: row.narrative,
    concepts: JSON.parse(row.concepts) as string[],
    filesRead: JSON.parse(row.files_read) as string[],
    filesModified: JSON.parse(row.files_modified) as string[],
    discoveryTokens: row.discovery_tokens,
    readTokens: row.read_tokens,
    contentHash: row.content_hash,
    embedding: unpackEmbedding(row.embedding),
  };
}

/** Sanitize a free-text query into a safe FTS5 MATCH expression, or null. */
function ftsMatchExpr(query: string): string | null {
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter((t) => t.length > 0);
  if (terms.length === 0) return null;
  return terms.map((t) => `"${t}"`).join(" OR ");
}

class SqliteStore implements MemStore {
  readonly id = "sqlite" as const;
  constructor(
    private readonly db: SqliteDb,
    readonly fts: boolean,
  ) {}

  async put(obs: ObservationInput): Promise<number | null> {
    try {
      const dup = this.db
        .prepare("SELECT id FROM observations WHERE content_hash = ? LIMIT 1")
        .get(obs.contentHash) as { id: number } | undefined;
      if (dup) return null;
      const info = this.db
        .prepare(INSERT_SQL)
        .run(
          obs.ts,
          obs.project,
          obs.type,
          obs.title,
          obs.subtitle ?? null,
          JSON.stringify(obs.facts),
          obs.narrative,
          JSON.stringify(obs.concepts),
          JSON.stringify(obs.filesRead),
          JSON.stringify(obs.filesModified),
          obs.discoveryTokens,
          obs.readTokens,
          obs.contentHash,
          packEmbedding(obs.embedding),
        );
      return Number(info.lastInsertRowid);
    } catch {
      return null;
    }
  }

  async get(ids: number[]): Promise<Observation[]> {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    const rows = this.db
      .prepare(`SELECT * FROM observations WHERE id IN (${placeholders}) ORDER BY id ASC`)
      .all(...ids) as ObsRow[];
    return rows.map(rowToObs);
  }

  async recent(limit: number): Promise<Observation[]> {
    const rows = this.db
      .prepare("SELECT * FROM observations ORDER BY id DESC LIMIT ?")
      .all(Math.max(0, limit)) as ObsRow[];
    return rows.map(rowToObs).reverse();
  }

  async all(): Promise<Observation[]> {
    const rows = this.db.prepare("SELECT * FROM observations ORDER BY id ASC").all() as ObsRow[];
    return rows.map(rowToObs);
  }

  async ftsSearch(query: string, limit: number): Promise<number[]> {
    if (!this.fts) return [];
    const match = ftsMatchExpr(query);
    if (!match) return [];
    try {
      const rows = this.db
        .prepare("SELECT rowid FROM obs_fts WHERE obs_fts MATCH ? ORDER BY rank LIMIT ?")
        .all(match, Math.max(1, limit)) as { rowid: number }[];
      return rows.map((r) => r.rowid);
    } catch {
      return [];
    }
  }

  async around(anchor: number, before: number, after: number): Promise<Observation[]> {
    const pre = this.db
      .prepare("SELECT * FROM observations WHERE id <= ? ORDER BY id DESC LIMIT ?")
      .all(anchor, Math.max(0, before) + 1) as ObsRow[];
    const post = this.db
      .prepare("SELECT * FROM observations WHERE id > ? ORDER BY id ASC LIMIT ?")
      .all(anchor, Math.max(0, after)) as ObsRow[];
    return [...pre.reverse(), ...post].map(rowToObs);
  }

  async hasHash(hash: string): Promise<boolean> {
    const row = this.db
      .prepare("SELECT 1 AS one FROM observations WHERE content_hash = ? LIMIT 1")
      .get(hash);
    return row !== undefined;
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // Best-effort.
    }
  }
}

// --- In-memory + JSONL fallback ---------------------------------------------

class MemoryStore implements MemStore {
  readonly id = "memory" as const;
  readonly fts = false;
  private readonly map = new Map<number, Observation>();
  private readonly hashes = new Set<string>();
  private nextId = 1;

  private constructor(
    private readonly dir: string,
    private readonly path: string,
  ) {}

  static async open(dir: string, project: string): Promise<MemoryStore> {
    const store = new MemoryStore(dir, join(dir, `${project}.jsonl`));
    await store.replay();
    return store;
  }

  private async replay(): Promise<void> {
    let raw: string;
    try {
      raw = await fs.readFile(this.path, "utf8");
    } catch {
      return;
    }
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const obs = JSON.parse(trimmed) as Observation;
        this.map.set(obs.id, obs);
        this.hashes.add(obs.contentHash);
        if (obs.id >= this.nextId) this.nextId = obs.id + 1;
      } catch {
        // Skip corrupt lines.
      }
    }
  }

  private sorted(): Observation[] {
    return [...this.map.values()].sort((a, b) => a.id - b.id);
  }

  async put(obs: ObservationInput): Promise<number | null> {
    if (this.hashes.has(obs.contentHash)) return null;
    const id = this.nextId++;
    const full: Observation = { ...obs, id };
    this.map.set(id, full);
    this.hashes.add(obs.contentHash);
    try {
      await fs.mkdir(this.dir, { recursive: true });
      await fs.appendFile(this.path, `${JSON.stringify(full)}\n`, "utf8");
    } catch {
      // Persistence is best-effort; the in-memory copy is authoritative this session.
    }
    return id;
  }

  async get(ids: number[]): Promise<Observation[]> {
    const wanted = new Set(ids);
    return this.sorted().filter((o) => wanted.has(o.id));
  }

  async recent(limit: number): Promise<Observation[]> {
    const all = this.sorted();
    return limit > 0 ? all.slice(-limit) : all;
  }

  async all(): Promise<Observation[]> {
    return this.sorted();
  }

  async ftsSearch(): Promise<number[]> {
    return [];
  }

  async around(anchor: number, before: number, after: number): Promise<Observation[]> {
    const all = this.sorted();
    const idx = all.findIndex((o) => o.id >= anchor);
    if (idx === -1) return all.slice(-Math.max(0, before) - 1);
    const start = Math.max(0, idx - Math.max(0, before));
    const end = idx + Math.max(0, after) + 1;
    return all.slice(start, end);
  }

  async hasHash(hash: string): Promise<boolean> {
    return this.hashes.has(hash);
  }

  close(): void {
    // Nothing to release.
  }
}

// --- Factory ----------------------------------------------------------------

async function openSqlite(
  dir: string,
  project: string,
): Promise<{ db: SqliteDb; fts: boolean } | null> {
  let DatabaseSync: (new (path: string) => SqliteDb) | undefined;
  try {
    ({ DatabaseSync } = (await import("node:sqlite")) as unknown as {
      DatabaseSync: new (path: string) => SqliteDb;
    });
  } catch {
    return null; // runtime without node:sqlite — fall back to in-memory.
  }
  try {
    await fs.mkdir(dir, { recursive: true });
    const db = new DatabaseSync(join(dir, `${project}.db`));
    const version = (db.prepare("PRAGMA user_version").get() as { user_version?: number })
      .user_version;
    if (version !== SCHEMA_VERSION) {
      db.exec("DROP TABLE IF EXISTS obs_fts; DROP TABLE IF EXISTS observations;");
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    }
    db.exec(BASE_SCHEMA);
    let fts = true;
    try {
      db.exec(FTS_SCHEMA);
    } catch {
      fts = false; // node:sqlite build without FTS5 → BM25 fallback.
    }
    return { db, fts };
  } catch {
    return null;
  }
}

async function openForKey(project: string, dir: string, useSqlite: boolean): Promise<MemStore> {
  if (useSqlite) {
    const sqlite = await openSqlite(dir, project);
    if (sqlite) return new SqliteStore(sqlite.db, sqlite.fts);
  }
  return MemoryStore.open(dir, project);
}

/**
 * Open the observation store for `cwd`. Uses SQLite (with FTS5 when available)
 * under `~/.arterm/cmem/`, else an in-memory store backed by JSONL. Pass
 * `sqlite: false` to force the in-memory/JSONL backend (used by tests). Also
 * registers the project so the viewer/MCP server can enumerate + name it.
 */
export async function openMemStore(
  cwd: string,
  opts: { dir?: string; sqlite?: boolean } = {},
): Promise<MemStore> {
  const dir = opts.dir ?? CMEM_DIR;
  try {
    await registerProject(cwd, Date.now(), dir);
  } catch {
    // Registration is best-effort — the store works without the index.
  }
  return openForKey(projectKey(cwd), dir, opts.sqlite !== false);
}

/**
 * Open a store when you only have the project key (used by the viewer/MCP server
 * for cross-project reads, where the original cwd isn't available).
 */
export function openStoreByKey(
  key: string,
  opts: { dir?: string; sqlite?: boolean } = {},
): Promise<MemStore> {
  return openForKey(key, opts.dir ?? CMEM_DIR, opts.sqlite !== false);
}

/** All projects on this machine that have a cmem store, newest-updated first. */
export function listCmemProjects(dir: string = CMEM_DIR): Promise<ProjectInfo[]> {
  return listMemoryProjects(dir);
}
