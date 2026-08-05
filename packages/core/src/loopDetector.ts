import { createHash } from "node:crypto";
import type { EventBus } from "./eventBus.js";
import type { Middleware, ResponseCtx, ToolCallCtx } from "./kernel/pipeline.js";

export interface LoopDetectOptions {
  /** Master switch (default true). */
  enabled?: boolean;
  /** Identical repeats before a corrective steer note (default 3). */
  steerAfter?: number;
  /** Identical repeats before the turn is cut (default 5). */
  cutAfter?: number;
  /** Sliding-window size for the per-call repeat check (default 10). */
  window?: number;
  /**
   * Tools exempt from the repeat checks. Some calls are identical BY DESIGN —
   * `gdb next`, `tail -f`, polling a build — and the only published
   * false-positive complaint against a shipped detector is from users whose
   * correct behavior was killed, with a global off-switch as their only remedy.
   */
  exempt?: string[];
  /**
   * Consecutive turns with zero tool calls before the model is told it is only
   * talking (default 3). Text-only replies are otherwise skipped, so a model
   * that narrates forever without acting trips nothing at all.
   */
  monologueAfter?: number;
}

export interface LoopDetector {
  /** Response-pipeline stage: iteration fingerprint (register after `recoverToolCalls`). */
  responseStage: Middleware<ResponseCtx>;
  /** toolCall-pipeline stage: sliding-window per-call repeats (register after `execute`). */
  toolCallStage: Middleware<ToolCallCtx>;
  /**
   * Reset the per-turn half of the state (the call window and any pending cut),
   * and close the books on the turn that just ended (monologue accounting).
   * The iteration-fingerprint streak deliberately survives — an eternal run is
   * many turns of the same directive, and repetition ACROSS steps is exactly
   * what the fingerprint exists to catch.
   */
  resetTurn(): void;
}

const sha1 = (s: string): string => createHash("sha1").update(s).digest("hex");

/** Result text beyond this is dropped before hashing — the head identifies it. */
const RESULT_HASH_CHARS = 4000;

/**
 * Strip the parts of a tool result that change on every run even when nothing
 * else does: timestamps, durations, pids, temp paths, hex ids.
 *
 * Without this, result-awareness would be worthless — two identical `ls` runs
 * differ by a millisecond somewhere and would read as progress forever. With
 * too much of it (masking every number) "3 tests failed" and "5 tests failed"
 * collapse into one, which reads as a loop while the run is actually fixing
 * things. These patterns are the narrow, boring middle.
 */
export function normalizeResult(text: string): string {
  return text
    .slice(0, RESULT_HASH_CHARS)
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g, "<ts>")
    .replace(/\b\d{2}:\d{2}:\d{2}(?:\.\d+)?\b/g, "<time>")
    .replace(/\b\d+(?:\.\d+)?\s?(?:ms|s|sec|secs|seconds|m|min|mins)\b/gi, "<dur>")
    .replace(/\bpid[= ]\d+/gi, "pid=<n>")
    .replace(/\/tmp\/[\w./-]+/g, "<tmp>")
    .replace(/\b[0-9a-f]{7,40}\b/gi, "<hex>")
    .trim();
}

/**
 * The identity of an error, independent of which tool or arguments produced it.
 *
 * The fingerprint keys on the CALL, so "five different commands, all failing
 * with the same ENOENT" is structurally invisible to it — and that is the most
 * common real-world stall. Masking digits and paths is right here (unlike for
 * results): `ENOENT: no such file 'a.ts'` and `… 'b.ts'` are the same problem.
 */
export function errorIdentity(text: string): string {
  const firstLine = text.split("\n").find((l) => l.trim()) ?? text;
  return firstLine
    .toLowerCase()
    .slice(0, 200)
    .replace(/['"`][^'"`]*['"`]/g, "<x>")
    .replace(/\/[\w./-]+/g, "<path>")
    .replace(/\d+/g, "<n>")
    .trim();
}

/**
 * Longest tail cycle in `hashes`: how many times a repeating block of length
 * `period` (1..maxPeriod) repeats at the end. Period 1 is plain repetition,
 * period 2 is A-B-A-B, period 3 catches the three-file thrash a consecutive
 * counter and a pair check both miss.
 */
export function tailCycle(
  hashes: readonly string[],
  maxPeriod = 5,
): { period: number; repeats: number } {
  let best = { period: 1, repeats: 1 };
  for (let period = 1; period <= maxPeriod; period++) {
    if (hashes.length < period * 2) break;
    let repeats = 1;
    while ((repeats + 1) * period <= hashes.length) {
      const a = hashes.length - repeats * period;
      const b = a - period;
      let same = true;
      for (let i = 0; i < period; i++) {
        if (hashes[b + i] !== hashes[a + i]) {
          same = false;
          break;
        }
      }
      if (!same) break;
      repeats += 1;
    }
    if (repeats > best.repeats) best = { period, repeats };
  }
  return best;
}

/**
 * Loop/stuck detector: complementary views of "no progress", all steering
 * before they cut (WrongStack's steer-then-cut shape).
 *
 * - The ITERATION FINGERPRINT (tool-name set + first call's arguments + the
 *   PREVIOUS iteration's results) catches a model re-planning the same batch
 *   every iteration. Results are part of the key on purpose: identical calls
 *   whose output keeps changing are progress — a build watcher, a debugger
 *   step, a poll — and cutting those is the one false positive that reliably
 *   makes users disable a detector outright.
 * - The SLIDING WINDOW of per-call hashes catches cycles a consecutive counter
 *   never sees, at any period up to 5 (A-B-A-B, A-B-C-A-B-C, …).
 * - The ERROR-IDENTITY STREAK is argument-agnostic: the same failure reached
 *   through different calls, which the two views above cannot see at all.
 * - The MONOLOGUE counter catches the model that talks and never acts.
 *
 * One closure holds all state, so a single detector instance must be created
 * per agent and its stages registered together.
 */
export function createLoopDetector(opts: LoopDetectOptions & { bus: EventBus }): LoopDetector {
  const steerAfter = opts.steerAfter ?? 3;
  const cutAfter = opts.cutAfter ?? 5;
  const windowSize = opts.window ?? 10;
  const monologueAfter = opts.monologueAfter ?? 3;
  const exempt = new Set(opts.exempt ?? []);
  const bus = opts.bus;

  let lastFingerprint = "";
  let fingerprintStreak = 0;
  let recentHashes: string[] = [];
  let pendingNote: string | undefined;
  let cutPending = false;
  // Results seen since the last fingerprint, folded into the next one.
  let iterationResults: string[] = [];
  let lastResultsDigest = "";
  // Argument-agnostic error tracking.
  let lastErrorId = "";
  let errorStreak = 0;
  let nudgedErrorId = "";
  // Monologue: turns that used no tool at all.
  let sawToolThisTurn = false;
  let turnStarted = false;
  let monologueStreak = 0;

  const resetAll = () => {
    lastFingerprint = "";
    fingerprintStreak = 0;
    recentHashes = [];
    pendingNote = undefined;
    cutPending = false;
    iterationResults = [];
    lastResultsDigest = "";
    lastErrorId = "";
    errorStreak = 0;
    nudgedErrorId = "";
  };

  const responseStage: Middleware<ResponseCtx> = async (ctx, next) => {
    if (ctx.calls.length === 0) {
      // A text-only reply ends the turn — SKIP it rather than reset. Every
      // eternal step closes with one, so resetting here would blind the
      // fingerprint to the exact cross-step repetition it exists to catch.
      // But a turn that used no tool AT ALL is a monologue, and after a few of
      // those the model is told so — in its own reply, since there is no tool
      // result left to carry a note.
      if (!sawToolThisTurn && turnStarted && monologueStreak + 1 >= monologueAfter) {
        const streak = monologueStreak + 1;
        const note = `[loop-guard] That is ${streak} replies in a row with no tool call. Talking is not doing: call a tool to make progress, or state plainly what is blocking you and stop.`;
        bus.emit({ type: "loop_detected", streak, note });
        ctx.text = ctx.text ? `${ctx.text}\n\n${note}` : note;
      }
      await next();
      return;
    }
    const names = [...new Set(ctx.calls.map((c) => c.name))].sort().join(",");
    const first = ctx.calls[0];
    const fingerprint = sha1(`${names}|${JSON.stringify(first?.arguments ?? {})}`);
    // Results are a RESET CONDITION rather than part of the key. That keeps the
    // original timing (steer at 3, cut at 5) while making a streak mean "same
    // calls AND nothing changed"; folding them into the key would delay every
    // detection by one iteration, because the first repeat has no earlier
    // results to compare against.
    const digest = iterationResults.length > 0 ? sha1(iterationResults.join(" ")) : "";
    // Bootstrap counts as unchanged: a single iteration's results cannot prove
    // progress on their own, and treating them as movement would blind the
    // detector to the very first repetition.
    const resultsMoved = lastResultsDigest !== "" && digest !== "" && digest !== lastResultsDigest;
    fingerprintStreak =
      fingerprint === lastFingerprint && !resultsMoved ? fingerprintStreak + 1 : 1;
    lastFingerprint = fingerprint;
    lastResultsDigest = digest;
    iterationResults = [];

    if (cutPending || fingerprintStreak >= cutAfter) {
      const streak = fingerprintStreak;
      bus.emit({ type: "loop_cut", streak });
      const note =
        "[loop-cut] The loop detector ended this turn: the same tool calls kept repeating " +
        "with no progress. The next attempt must take a different approach.";
      ctx.text = ctx.text ? `${ctx.text}\n\n${note}` : note;
      // Emptying the calls is the cut: the loop's own "no tool calls" exit ends
      // the turn with a well-formed history and no unanswered tool_call.
      ctx.calls = [];
      resetAll();
      await next();
      return;
    }
    if (fingerprintStreak >= steerAfter) {
      const note = `[loop-guard] The last ${fingerprintStreak} iterations repeated the same tool calls with the same results and are not making progress. Take a DIFFERENT approach — change the arguments, use another tool, or state what is blocking you.`;
      bus.emit({ type: "loop_detected", streak: fingerprintStreak, note });
      // Delivered on the iteration's first tool result (below), where corrective
      // notes are proven to reach small local models.
      pendingNote = note;
    }
    await next();
  };

  const toolCallStage: Middleware<ToolCallCtx> = async (ctx, next) => {
    sawToolThisTurn = true;
    const output = ctx.output ?? "";
    const normalized = normalizeResult(output);
    iterationResults.push(`${ctx.call.name}:${sha1(normalized)}`);

    // Same failure through DIFFERENT calls: the fingerprint keys on the call,
    // so this is invisible to it, and it is the most common real stall.
    if (ctx.isError && output.trim()) {
      const id = errorIdentity(output);
      errorStreak = id === lastErrorId ? errorStreak + 1 : 1;
      lastErrorId = id;
      // Nudge once per identity: a frozen streak that re-nudges every step just
      // spends context repeating itself.
      if (errorStreak >= steerAfter && nudgedErrorId !== id) {
        nudgedErrorId = id;
        const first = output.split("\n")[0]?.slice(0, 160) ?? "";
        const note = `[loop-guard] You have hit this same error ${errorStreak}x, with different calls: "${first}". The arguments are not the problem — fix the underlying cause or take a different approach.`;
        bus.emit({ type: "loop_detected", streak: errorStreak, note });
        ctx.output = ctx.output ? `${ctx.output}\n\n${note}` : note;
      }
    } else if (!ctx.isError) {
      errorStreak = 0;
      lastErrorId = "";
      nudgedErrorId = "";
    }

    if (exempt.has(ctx.call.name)) {
      // Repeating by design (a debugger step, a poll). Still recorded above so
      // its results feed the fingerprint; just never counted as a repeat.
      if (pendingNote) {
        ctx.output = ctx.output ? `${ctx.output}\n\n${pendingNote}` : pendingNote;
        pendingNote = undefined;
      }
      await next();
      return;
    }

    // The RESULT is part of the key: an identical call whose output changed is
    // a poll making progress, not a loop.
    const hash = sha1(
      `${ctx.call.name}:${JSON.stringify(ctx.call.arguments ?? {})}:${sha1(normalized)}`,
    );
    recentHashes.push(hash);
    if (recentHashes.length > windowSize) recentHashes.shift();
    const identical = recentHashes.filter((h) => h === hash).length;
    // Cycles of any period up to 5, so A-B-C-A-B-C counts as three repeats of a
    // three-call block rather than one occurrence of each.
    const cycle = tailCycle(recentHashes);
    const count = Math.max(identical, cycle.period > 1 ? cycle.repeats : 0);
    const what = cycle.period > 1 && cycle.repeats >= count ? `${cycle.period}-call cycle` : "call";

    if (count >= cutAfter) {
      // Acted on at the next iteration boundary: cutting mid-batch would leave
      // recorded tool_calls without results.
      cutPending = true;
      const note = `[loop-guard] This ${what} has now repeated ${count}x with identical arguments and identical results; the turn will be cut. Stop repeating it.`;
      bus.emit({ type: "loop_detected", streak: count, note });
      ctx.output = ctx.output ? `${ctx.output}\n\n${note}` : note;
    } else if (count >= steerAfter) {
      const note = `[loop-guard] This ${what} has now repeated ${count}x with identical arguments and identical results within the last ${windowSize} calls and is not making progress. Change the arguments or move on.`;
      bus.emit({ type: "loop_detected", streak: count, note });
      ctx.output = ctx.output ? `${ctx.output}\n\n${note}` : note;
    }
    if (pendingNote) {
      ctx.output = ctx.output ? `${ctx.output}\n\n${pendingNote}` : pendingNote;
      pendingNote = undefined;
    }
    await next();
  };

  return {
    responseStage,
    toolCallStage,
    resetTurn() {
      // Close the books on the turn that just ended before clearing per-turn
      // state: a turn that called no tool is one step of a monologue.
      if (turnStarted) monologueStreak = sawToolThisTurn ? 0 : monologueStreak + 1;
      turnStarted = true;
      sawToolThisTurn = false;
      recentHashes = [];
      pendingNote = undefined;
      cutPending = false;
      iterationResults = [];
    },
  };
}
