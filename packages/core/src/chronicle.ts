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

/** Seals records into a chain and hands them to a sink. One per session. */
export class Chronicle {
  private sequence = 0;
  private previousHash = GENESIS_HASH;

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
    try {
      this.sink.write(record);
    } catch {
      // See above: recorded or not, the chain is intact and the run goes on.
    }
    return record;
  }
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
): Middleware<ToolCallCtx> {
  return async (ctx, next) => {
    const started = Date.now();
    let executed = false;
    try {
      await next();
      executed = ctx.tool !== undefined;
    } finally {
      const change = await describeChange(ctx, cwd);
      chronicle.append({
        eventType: executed ? "tool.executed" : "tool.denied",
        outcome: !executed ? "denied" : ctx.isError ? "failure" : "success",
        scope: {},
        ...(ctx.call.name ? { toolName: ctx.call.name } : {}),
        ...(ctx.call.id ? { toolCallId: ctx.call.id } : {}),
        durationMs: Date.now() - started,
        ...(change ? { change } : {}),
      });
    }
  };
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
