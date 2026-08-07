/**
 * The strategy behind the work, written down.
 *
 * `todo` is the run's step list, held in memory and gone when the process
 * exits. That is right for steps and wrong for the thing above them: WHY this
 * shape, what was decided and rejected, what "done" means. That survives a
 * `/clear`, a restart, and the user going to lunch — and today it survives none
 * of them, because the only place to put it was a prose paragraph that the next
 * compaction ate.
 *
 * Two decisions about scope, both of which cut against "more persistence is
 * better":
 *
 * - **One plan per session, keyed by session id**, not per project. A plan is
 *   about a piece of work in flight. A project-wide file would be read by a
 *   session started three days later for something unrelated, and a stale plan
 *   silently steering a new run is worse than no plan — the model has no way
 *   to tell "the strategy" from "someone's strategy, once".
 * - **It is written, not merged.** Same argument as `todo`: a partial update
 *   to a plan the model half-remembers is the failure mode, so `set` replaces
 *   and `get` returns exactly what was stored.
 */

import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { ARTERM_HOME } from "./config.js";

export interface PlanDoc {
  /** One line: what this work is. */
  title: string;
  /** The strategy, in the model's own words. Markdown, unstructured on purpose. */
  body: string;
  /** Epoch ms of the last write — a plan with no age cannot be judged. */
  updatedAt: number;
}

/** Where a session's plan lives. */
export function planPath(sessionId: string, home: string = ARTERM_HOME): string {
  return join(home, "plans", `${sessionId}.json`);
}

/**
 * A session's plan on disk.
 *
 * Reads tolerate a missing or corrupt file by returning nothing: a plan is an
 * aid, and a run that cannot start because its notes are malformed is a worse
 * outcome than a run without notes.
 */
export class PlanStore {
  constructor(private readonly file: string) {}

  async get(): Promise<PlanDoc | undefined> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, "utf8")) as Partial<PlanDoc>;
      if (typeof parsed.title !== "string" || typeof parsed.body !== "string") return undefined;
      return {
        title: parsed.title,
        body: parsed.body,
        updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : 0,
      };
    } catch {
      return undefined;
    }
  }

  async set(title: string, body: string, now: number = Date.now()): Promise<PlanDoc> {
    const doc: PlanDoc = { title, body, updatedAt: now };
    await fs.mkdir(dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
    return doc;
  }

  async clear(): Promise<void> {
    await fs.rm(this.file, { force: true });
  }
}

/** How long ago, in words a reader can act on. */
export function planAge(updatedAt: number, now: number = Date.now()): string {
  const ms = Math.max(0, now - updatedAt);
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
