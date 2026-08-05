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
}

export interface LoopDetector {
  /** Response-pipeline stage: iteration fingerprint (register after `recoverToolCalls`). */
  responseStage: Middleware<ResponseCtx>;
  /** toolCall-pipeline stage: sliding-window per-call repeats (register after `loopGuard`). */
  toolCallStage: Middleware<ToolCallCtx>;
  /**
   * Reset the per-turn half of the state (the call window and any pending cut).
   * The iteration-fingerprint streak deliberately survives — an eternal run is
   * many turns of the same directive, and repetition ACROSS steps is exactly
   * what the fingerprint exists to catch.
   */
  resetTurn(): void;
}

const sha1 = (s: string): string => createHash("sha1").update(s).digest("hex");

/**
 * Loop/stuck detector: two complementary views of "no progress", both steering
 * before they cut (WrongStack's steer-then-cut shape).
 *
 * - The ITERATION FINGERPRINT (tool-name set + first call's arguments) catches
 *   a model re-planning the same batch every iteration. At `steerAfter`
 *   consecutive repeats a corrective note rides the next tool result; at
 *   `cutAfter` the turn is cut by emptying `ctx.calls` — the loop's own
 *   "no calls → done" exit, so history stays well-formed and `run()` is never
 *   edited. The streak survives across turns on purpose: eternal-mode steps
 *   are separate turns repeating one directive.
 * - The SLIDING WINDOW of per-call hashes catches A-B-A-B alternation that a
 *   consecutive counter never sees. Window state is per-turn (`resetTurn`):
 *   across turns the fingerprint is the authority.
 *
 * One closure holds all state, so a single detector instance must be created
 * per agent and its stages registered together.
 */
export function createLoopDetector(opts: LoopDetectOptions & { bus: EventBus }): LoopDetector {
  const steerAfter = opts.steerAfter ?? 3;
  const cutAfter = opts.cutAfter ?? 5;
  const windowSize = opts.window ?? 10;
  const bus = opts.bus;

  let lastFingerprint = "";
  let fingerprintStreak = 0;
  let recentHashes: string[] = [];
  let pendingNote: string | undefined;
  let cutPending = false;

  const resetAll = () => {
    lastFingerprint = "";
    fingerprintStreak = 0;
    recentHashes = [];
    pendingNote = undefined;
    cutPending = false;
  };

  const responseStage: Middleware<ResponseCtx> = async (ctx, next) => {
    if (ctx.calls.length === 0) {
      // A text-only reply ends the turn — SKIP it rather than reset. Every
      // eternal step closes with one, so resetting here would blind the
      // fingerprint to the exact cross-step repetition it exists to catch.
      await next();
      return;
    }
    const names = [...new Set(ctx.calls.map((c) => c.name))].sort().join(",");
    const first = ctx.calls[0];
    const fingerprint = sha1(`${names}|${JSON.stringify(first?.arguments ?? {})}`);
    fingerprintStreak = fingerprint === lastFingerprint ? fingerprintStreak + 1 : 1;
    lastFingerprint = fingerprint;

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
      const note = `[loop-guard] The last ${fingerprintStreak} iterations repeated the same tool calls and are not making progress. Take a DIFFERENT approach — change the arguments, use another tool, or state what is blocking you.`;
      bus.emit({ type: "loop_detected", streak: fingerprintStreak, note });
      // Delivered on the iteration's first tool result (below), where corrective
      // notes are proven to reach small local models.
      pendingNote = note;
    }
    await next();
  };

  const toolCallStage: Middleware<ToolCallCtx> = async (ctx, next) => {
    const hash = sha1(`${ctx.call.name}:${JSON.stringify(ctx.call.arguments ?? {})}`);
    recentHashes.push(hash);
    if (recentHashes.length > windowSize) recentHashes.shift();
    const count = recentHashes.filter((h) => h === hash).length;
    if (count >= cutAfter) {
      // Acted on at the next iteration boundary: cutting mid-batch would leave
      // recorded tool_calls without results.
      cutPending = true;
      const note = `[loop-guard] This call has now run ${count}x with identical arguments and the turn will be cut. Stop repeating it.`;
      bus.emit({ type: "loop_detected", streak: count, note });
      ctx.output = ctx.output ? `${ctx.output}\n\n${note}` : note;
    } else if (count >= steerAfter) {
      const note =
        `[loop-guard] This call has now run ${count}x with identical arguments within the ` +
        `last ${windowSize} calls and is not making progress. Change the arguments or move on.`;
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
      recentHashes = [];
      pendingNote = undefined;
      cutPending = false;
    },
  };
}
