/**
 * A tamper-evident record of what a run actually DID, kept apart from what it
 * said it did.
 *
 * The gap this closes is stated in CLAUDE.md's own account of the verify gate:
 * the judge "only reads the result. It never sees the diff, so it cannot catch
 * work that contradicts the goal." Observed twice — a fleet worker rewrote
 * `slug()`, committed it as `docs(…)`, and the judge passed it with "the
 * function's behavior was not touched"; and an autonomous run that fixed two
 * real bugs reported a mechanism for one of them that had never happened. In
 * both cases the run's own narration was the only account of the run, and it
 * was wrong in a direction nothing could check.
 *
 * So the ledger records the seam rather than the story. A tool call's
 * `path`/`diff` are produced by the TOOL — `diff` is explicitly never sent to
 * the model (see `ToolResult`) — and `contentHashAfter` is read back off the
 * disk. None of the three can be written by a model composing a summary.
 *
 * This file is the MAPPING half: the envelope, the hash chain, and which seam
 * becomes which record. The mechanism (where bytes land) is a {@link
 * ChronicleSink} implemented in `@arterm/cli`, the same split `telemetry.ts`
 * and the sandbox use, so `core` stays free of storage decisions and a session
 * with no sink attached pays nothing.
 *
 * Adapted from WrongStack's Chronicle. What is taken is the hash chain and the
 * event envelope; what is deliberately left is its SQLite journal, project
 * server, partitions and rollups — those serve a cross-machine HQ, and Arterm
 * is one process writing one file.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { Middleware, ToolCallCtx } from "./kernel/pipeline.js";
import type { Tool } from "./types.js";
import type { WorkspaceWatcher } from "./workspaceWatch.js";

/** Bump only for a change that makes older records unreadable. */
export const CHRONICLE_SCHEMA_VERSION = 1 as const;

/** `previousHash` of the first record in a chain. */
export const GENESIS_HASH = "0".repeat(64);

export type ChronicleOutcome = "success" | "failure" | "denied";

/** Where in a run the record happened. Every field is optional by design: a
 *  sub-agent has no turn of its own, and a headless run has no session file. */
export interface ChronicleScope {
  sessionId?: string;
  turnId?: string;
  agentId?: string;
}

/** What a tool call did to one file, measured rather than reported. */
export interface ChronicleChange {
  /** As the tool named it — relative to the session cwd, or absolute. */
  path: string;
  /** Diff rows the tool produced. `diff` never reaches the model. */
  added: number;
  removed: number;
  /**
   * SHA-256 of the file as it stands AFTER the call, read from disk.
   *
   * Absent when the path could not be read — a delete, or a tool that named a
   * path it did not write. Absent is a fact, not a gap: it distinguishes "the
   * file is gone" from "the file is unchanged", which a diff alone cannot.
   */
  contentHashAfter?: string;
}

export interface ChronicleRecordInput {
  eventType: string;
  outcome: ChronicleOutcome;
  scope: ChronicleScope;
  toolName?: string;
  toolCallId?: string;
  /** Decision + execution, in ms. Not a latency metric — see `chronicleToolCall`. */
  durationMs?: number;
  change?: ChronicleChange;
  attributes?: Record<string, unknown>;
}

/** A sealed record: the input, its position in the chain, and its hash. */
export interface ChronicleRecord extends ChronicleRecordInput {
  schemaVersion: typeof CHRONICLE_SCHEMA_VERSION;
  sequence: number;
  observedAt: string;
  previousHash: string;
  hash: string;
}

export type ChronicleVerifyResult =
  | { ok: true; entries: number; lastSequence: number; lastHash: string }
  | { ok: false; entries: number; brokenAt: number; reason: string };

/**
 * Where sealed records go. Implemented in `@arterm/cli`.
 *
 * `write` returns nothing and MUST NOT throw: a ledger that can fail the run it
 * observes is a worse trade than no ledger, which is `telemetry.ts`'s policy
 * and the opposite of the sandbox's on purpose — this records, it does not
 * control.
 */
export interface ChronicleSink {
  write(record: ChronicleRecord): void;
}

/**
 * Deterministic JSON: keys sorted, `undefined` members dropped, `undefined`
 * array elements written as `null`.
 *
 * This is part of the durable format, not an implementation detail. Two subtly
 * different encoders produce two incompatible chains, and the divergence
 * surfaces later as a "tampered" verdict on a file nobody touched — so there is
 * one encoder and every reader uses it.
 *
 * The bytes on disk are ordinary `JSON.stringify` output; the preimage is
 * always re-derived from the parsed record, never from the stored line.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) {
    return `[${value.map((v) => (v === undefined ? "null" : stableStringify(v))).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .sort()
    .filter((k) => obj[k] !== undefined);
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

export function hashValue(value: unknown): string {
  return createHash("sha256").update(stableStringify(value), "utf8").digest("hex");
}

/** The hash a stored record should carry — `hash` is excluded from its own preimage. */
export function recordHash(record: ChronicleRecord): string {
  const { hash: _omit, ...rest } = record;
  return hashValue(rest);
}

/**
 * Recompute the whole chain.
 *
 * Reports the FIRST break and stops. A ledger with a broken link says nothing
 * trustworthy about anything after it, so listing later breaks would invite
 * reading past the one that matters.
 */
export function verifyChain(records: readonly ChronicleRecord[]): ChronicleVerifyResult {
  let previous = GENESIS_HASH;
  for (const [i, record] of records.entries()) {
    if (record.previousHash !== previous) {
      return {
        ok: false,
        entries: records.length,
        brokenAt: record.sequence,
        reason: `record ${record.sequence} follows ${record.previousHash.slice(0, 12)}…, but ${
          i === 0 ? "the chain starts at the genesis hash" : "its predecessor hashes to"
        } ${previous.slice(0, 12)}…`,
      };
    }
    const expected = recordHash(record);
    if (expected !== record.hash) {
      return {
        ok: false,
        entries: records.length,
        brokenAt: record.sequence,
        reason: `record ${record.sequence} hashes to ${expected.slice(0, 12)}… but stores ${record.hash.slice(0, 12)}… — its contents changed after it was written`,
      };
    }
    previous = record.hash;
  }
  return {
    ok: true,
    entries: records.length,
    lastSequence: records.length > 0 ? (records[records.length - 1]?.sequence ?? 0) : 0,
    lastHash: previous,
  };
}

/** One file's net story across a run: who touched it, how much, what it is now. */
export interface ChronicleFileSummary {
  path: string;
  added: number;
  removed: number;
  /** The digest after the LAST write — what the file is now, not what it passed through. */
  contentHashAfter?: string;
  /** Every agent that wrote it. More than one is itself worth seeing in a fan-out. */
  by: string[];
  /** How many tool calls touched it. */
  writes: number;
  /**
   * Other writers that were alive when this file was measured as changing.
   *
   * Only ever set by the workspace watcher, and only when something else really
   * was running — a tool that declares its own write needs no such caveat,
   * because it is reporting what it did rather than what it noticed. Carried up
   * to the summary so the judge sees it beside the change: "this file moved
   * during the call" and "something else could have moved it" are two different
   * pieces of evidence and belong on one line.
   */
  concurrent?: string[];
}

/** Seals records into a chain and hands them to a sink. One per session. */
export class Chronicle {
  private sequence = 0;
  private previousHash = GENESIS_HASH;
  /**
   * Per-path aggregate, kept in memory so a caller can ask what the run changed
   * without re-reading the file it just wrote.
   *
   * Bounded by the number of distinct files a run touches rather than by its
   * length — a thousand edits to one file are one entry. The records themselves
   * are NOT kept: those are what the sink is for.
   */
  private files = new Map<string, ChronicleFileSummary>();
  private denied = 0;

  constructor(
    private readonly sink: ChronicleSink,
    private readonly scope: () => ChronicleScope = () => ({}),
  ) {}

  /**
   * Seal one record and write it.
   *
   * Swallows everything the sink can throw, for the reason on {@link
   * ChronicleSink}. The chain still advances, because a record that failed to
   * PERSIST is not a record that was tampered with — letting the sequence skip
   * would make an unwritable disk look like an edited ledger.
   */
  append(input: ChronicleRecordInput): ChronicleRecord {
    this.sequence += 1;
    const unsealed = {
      ...input,
      scope: { ...this.scope(), ...input.scope },
      schemaVersion: CHRONICLE_SCHEMA_VERSION,
      sequence: this.sequence,
      observedAt: new Date().toISOString(),
      previousHash: this.previousHash,
    };
    const record: ChronicleRecord = { ...unsealed, hash: hashValue(unsealed) };
    this.previousHash = record.hash;
    this.accumulate(record);
    try {
      this.sink.write(record);
    } catch {
      // See above: recorded or not, the chain is intact and the run goes on.
    }
    return record;
  }

  private accumulate(record: ChronicleRecord): void {
    if (record.outcome === "denied") this.denied += 1;
    const change = record.change;
    if (!change) return;
    const seen = this.files.get(change.path);
    const by = record.scope.agentId;
    const alongside = concurrentOf(record);
    if (!seen) {
      this.files.set(change.path, {
        path: change.path,
        added: change.added,
        removed: change.removed,
        ...(change.contentHashAfter ? { contentHashAfter: change.contentHashAfter } : {}),
        by: by ? [by] : [],
        writes: 1,
        ...(alongside.length > 0 ? { concurrent: alongside } : {}),
      });
      return;
    }
    seen.added += change.added;
    seen.removed += change.removed;
    seen.writes += 1;
    // The LAST digest wins: the question is what the file is now, not what it
    // passed through on the way. `undefined` overwrites too — a file deleted
    // after being written is deleted, however much was added first.
    seen.contentHashAfter = change.contentHashAfter;
    if (by && !seen.by.includes(by)) seen.by.push(by);
    // Accumulated, never replaced: a file touched twice, once cleanly and once
    // beside a running daemon, still has the doubt on it.
    for (const name of alongside) {
      seen.concurrent = seen.concurrent ?? [];
      if (!seen.concurrent.includes(name)) seen.concurrent.push(name);
    }
  }

  /** What the run changed so far, one entry per file, in first-touch order. */
  changed(): ChronicleFileSummary[] {
    return [...this.files.values()];
  }

  /** Tool calls the permission ladder refused. Zero is the usual answer. */
  deniedCount(): number {
    return this.denied;
  }
}

/** The other writers a record names, if any — tolerant of an untyped envelope. */
function concurrentOf(record: ChronicleRecord): string[] {
  const raw = record.attributes?.concurrent;
  return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
}

/** SHA-256 of a file's bytes, or undefined when it cannot be read. */
async function hashFile(path: string): Promise<string | undefined> {
  try {
    return createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
  } catch {
    return undefined;
  }
}

/**
 * The `toolCall` stage that writes the ledger.
 *
 * A stage rather than a bus listener, for `telemetry.ts`'s reason: only a stage
 * sees a call as one bracketed thing. Register it `before("permission")`, not
 * `before("execute")` where the telemetry span goes — a denied call never
 * reaches `execute`, and a denial is exactly the kind of event a summary
 * forgets. The cost of sitting that far out is that `durationMs` spans the
 * DECISION as well as the work, so under `ask` it includes however long a human
 * took. That is why this number is not the latency measurement: `gen_ai.*`
 * already brackets the execution alone, and two numbers that disagree are
 * better than one that is quietly wrong in one mode.
 */
export function chronicleToolCall(
  chronicle: Chronicle,
  cwd: () => string,
  scope: () => ChronicleScope = () => ({}),
  watch?: WorkspaceWatch,
): Middleware<ToolCallCtx> {
  return async (ctx, next) => {
    const started = Date.now();
    let executed = false;
    // A tool that declares no path and runs a command is the blind spot — see
    // `workspaceWatch.ts`. Taken BEFORE the call rather than derived after it,
    // which is the whole difference between measuring a change and inferring
    // one. A denied call pays for a snapshot it does not use; that is cheaper
    // than the alternative, since whether the call runs is not known yet.
    const before = watches(watch, ctx.call.name) ? await watch?.watcher.snapshot(cwd()) : undefined;
    try {
      await next();
      executed = ctx.tool !== undefined;
    } finally {
      const change = await describeChange(ctx, cwd);
      const observed =
        executed && before && watch ? await watch.watcher.changesSince(before, cwd()) : undefined;
      chronicle.append({
        eventType: executed ? "tool.executed" : "tool.denied",
        outcome: !executed ? "denied" : ctx.isError ? "failure" : "success",
        scope: scope(),
        ...(ctx.call.name ? { toolName: ctx.call.name } : {}),
        ...(ctx.call.id ? { toolCallId: ctx.call.id } : {}),
        durationMs: Date.now() - started,
        ...(change ? { change } : {}),
        ...(observed && observed.skipped > 0
          ? { attributes: { observedTruncated: observed.skipped } }
          : {}),
      });
      // One record per observed file, and NOT folded into the call's own
      // record: `change` is singular because a writing tool writes one file,
      // while a command writes as many as it likes. A separate `eventType`
      // keeps the execution count honest — three files must not read as three
      // tool calls — and marks the weaker provenance at the same time.
      for (const observedChange of observed?.changes ?? []) {
        chronicle.append({
          eventType: "file.observed",
          outcome: "success",
          scope: scope(),
          ...(ctx.call.name ? { toolName: ctx.call.name } : {}),
          ...(ctx.call.id ? { toolCallId: ctx.call.id } : {}),
          change: observedChange,
          // `concurrent` is the doubt, bounded and named. An empty array is a
          // finding, not a blank: it says the question was asked and nothing
          // else was running, which is what turns "a file moved around this
          // call" into "this call moved it".
          attributes: { observedBy: "git", concurrent: observed?.concurrent ?? [] },
        });
      }
    }
  };
}

/**
 * Measuring the tree around a call, for the calls that need it.
 *
 * `tools` is here because of WHERE this stage sits. It is registered
 * `before("permission")` so a denial is recorded, and `ctx.tool` is resolved BY
 * the permission stage — so at snapshot time the call is still just a name, and
 * a gate reading `ctx.tool` is a gate that never opens. That was not a
 * theoretical ordering concern: it silently disabled the whole feature, and the
 * seam test is what found it.
 */
export interface WorkspaceWatch {
  watcher: WorkspaceWatcher;
  /** The live roster, consulted by name. A name it does not know never runs. */
  tools: () => Tool[];
}

/**
 * Whether a tool's writes have to be measured rather than read off its result.
 *
 * The gate is "runs a command", not a name: `bash` is the case that motivated
 * it, but `exec` has the same shape, and so does any future tool or MCP server
 * that shells out. Read-category tools are excluded because the snapshot pair
 * is two `git` calls plus a digest of the dirty set, which is not worth paying
 * on every `grep`.
 */
function watches(watch: WorkspaceWatch | undefined, name: string): boolean {
  if (!watch) return false;
  const tool = watch.tools().find((t) => t.name === name);
  return tool !== undefined && (tool.category ?? "execute") === "execute";
}

/** What the call changed, from the tool's own declaration plus the disk. */
async function describeChange(
  ctx: ToolCallCtx,
  cwd: () => string,
): Promise<ChronicleChange | undefined> {
  if (!ctx.path) return undefined;
  const rows = ctx.diff ?? [];
  const absolute = isAbsolute(ctx.path) ? ctx.path : resolve(cwd(), ctx.path);
  const contentHashAfter = await hashFile(absolute);
  return {
    path: ctx.path,
    added: rows.filter((r) => r.kind === "add").length,
    removed: rows.filter((r) => r.kind === "del").length,
    ...(contentHashAfter ? { contentHashAfter } : {}),
  };
}
