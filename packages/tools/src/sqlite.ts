/**
 * Opening the on-disk cache the code indexes persist into.
 *
 * One file because the specifier below is the whole point, and it must not be
 * got right in one index and wrong in the other.
 *
 * `await import("node:sqlite")` does not survive the build. esbuild (through
 * tsup) normalises the `node:` prefix off a statically-visible builtin
 * specifier, so the bundle contains `await import("sqlite")` — a package that
 * does not exist — and the import throws. Vitest's resolver does the same
 * thing, which is why no test caught it: the failure is swallowed into "no
 * persistence available", and an index that silently rebuilds from scratch is
 * indistinguishable from one that loaded its cache. Both `symbolIndex` and
 * `callGraph` advertised SQLite persistence and neither had it in the shipped
 * binary.
 *
 * `createRequire` is what fixes it, and a computed dynamic-import specifier is
 * not: esbuild leaves that alone, but vitest's module runner resolves it at
 * RUNTIME and fails the same way, so the tests would still have reported no
 * persistence while the binary had it. A `require` of a builtin is rewritten by
 * neither. Loading a builtin through CJS is legal from ESM and costs nothing.
 */

import { promises as fs } from "node:fs";
import { createRequire } from "node:module";

/** Minimal subset of the `node:sqlite` DatabaseSync surface the indexes rely on. */
export interface SqliteStatement {
  run(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
}
export interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

/** Why SQLite is unavailable, when it is — surfaced by `code_stats`. */
let unavailable: string | undefined;
export function sqliteFailure(): string | undefined {
  return unavailable;
}

/** Load `node:sqlite`, or undefined on a runtime without it. */
function loadSqlite(): (new (path: string) => SqliteDb) | undefined {
  try {
    const require = createRequire(import.meta.url);
    const mod = require("node:sqlite") as { DatabaseSync: new (path: string) => SqliteDb };
    return mod.DatabaseSync;
  } catch (err) {
    unavailable = err instanceof Error ? err.message : String(err);
    return undefined;
  }
}

/**
 * Open (and migrate) a cache database, or return null.
 *
 * `schemaVersion` is checked against the file's `user_version`; a mismatch runs
 * `onMigrate` (which should drop the old tables) rather than trying to reshape
 * them. A cache is rebuildable by definition, so throwing it away is the cheap
 * and correct answer to a schema change.
 */
export async function openCacheDb(opts: {
  dir: string;
  file: string;
  schemaVersion: number;
  onMigrate(db: SqliteDb): void;
  schema: string;
}): Promise<SqliteDb | null> {
  const DatabaseSync = loadSqlite();
  if (!DatabaseSync) return null;
  try {
    await fs.mkdir(opts.dir, { recursive: true });
    const db = new DatabaseSync(`${opts.dir}/${opts.file}`);
    const version = (db.prepare("PRAGMA user_version").get() as { user_version?: number })
      ?.user_version;
    if (version !== opts.schemaVersion) {
      opts.onMigrate(db);
      db.exec(`PRAGMA user_version = ${opts.schemaVersion}`);
    }
    db.exec(opts.schema);
    return db;
  } catch (err) {
    unavailable = err instanceof Error ? err.message : String(err);
    return null;
  }
}
