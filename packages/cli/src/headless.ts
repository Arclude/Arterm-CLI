import type { TokenUsage } from "@arterm/core";
import type { Session } from "@arterm/tui";
import { ArtermUserError } from "./errors.js";

export interface HeadlessOptions {
  /** Emit a single JSON object instead of streaming plain text to stdout. */
  json?: boolean;
}

/** The structured result printed in `--json` mode. */
export interface HeadlessResult {
  response: string;
  usage?: TokenUsage;
  toolCalls: { name: string }[];
}

/**
 * Run a single prompt to completion without the Ink TUI, for scripting/CI.
 * In plain mode the model's text streams to stdout as it arrives; in `--json`
 * mode the whole turn is buffered and emitted as one object on stdout.
 *
 * Headless can't show an interactive permission prompt, so any tool that would
 * need one is denied (fail-closed, same as the TUI's default). A one-line hint
 * is printed to stderr if that happens and the session isn't in yolo mode.
 */
export async function runHeadless(
  session: Session,
  prompt: string,
  opts: HeadlessOptions = {},
): Promise<HeadlessResult> {
  if (!prompt.trim()) {
    throw new ArtermUserError('No prompt provided. Pass one with --print "…" or pipe it on stdin.');
  }

  let blocked = false;
  session.setAsker(async () => {
    blocked = true;
    return "deny";
  });

  let text = "";
  // Cleaned assistant replies (tool-call JSON already stripped by the response
  // pipeline). The streamed `text_delta` still carries the raw inline tool-call
  // text, so the structured/returned response is built from these instead.
  const replies: string[] = [];
  const toolCalls: { name: string }[] = [];
  let usage: TokenUsage | undefined;
  let errored: string | undefined;

  const unsubscribe = session.bus.on((event) => {
    switch (event.type) {
      case "text_delta":
        text += event.delta;
        if (!opts.json) process.stdout.write(event.delta);
        break;
      case "assistant_message": {
        const clean = event.message.content.trim();
        if (clean) replies.push(clean);
        break;
      }
      case "tool_call":
        toolCalls.push({ name: event.call.name });
        break;
      case "usage":
        usage = event.usage;
        break;
      case "error":
        errored = event.error;
        break;
    }
  });

  try {
    await session.agent.run(prompt);
  } finally {
    unsubscribe();
  }

  // Prefer the cleaned assistant replies; fall back to the raw stream if none were
  // recorded (e.g. a turn that errored before any assistant message).
  const response = replies.length > 0 ? replies.join("\n").trim() : text.trim();
  const result: HeadlessResult = { response, usage, toolCalls };

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (text && !text.endsWith("\n")) {
    // Keep the prompt on its own line after streamed output.
    process.stdout.write("\n");
  }

  if (errored) throw new ArtermUserError(errored);

  if (blocked && session.permissionMode !== "yolo") {
    process.stderr.write(
      "Note: some tools were blocked — headless mode can't prompt for permission. " +
        "Re-run with --yolo, or set an auto/yolo permission mode.\n",
    );
  }

  return result;
}

/** The structured result printed by a headless goal run in `--json` mode. */
export interface HeadlessGoalResult {
  goal: string;
  /** How the run ended. `stopped` carries a reason. */
  state: "done" | "stopped";
  summary: string;
  steps: number;
  /**
   * What the run consumed, reported whether or not a ceiling was configured.
   *
   * `guards.budget` below is about a CEILING — limits, breach, wrap-up — and is
   * rightly absent when there is none. Spend itself is not conditional on
   * anyone having set a limit: an evaluation harness has to report cost for
   * every trial, and "the operator passed --max-usd" is not a fact about the
   * run's cost. `unpriced` is what keeps a local model's honest $0 apart from a
   * priced model whose rates were missing from the catalog.
   */
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheTokens: number;
    /** Priced total — cache read/write counted at their own rates. */
    totalTokens: number;
    usd: number;
    /** True when at least one call had no catalog price, so `usd` under-counts. */
    unpriced: boolean;
    /**
     * True when the backend actually reported token counts. False means the
     * zeros above are "not reported", not "not spent" — most local servers
     * report nothing, and a harness that recorded their runs as free would be
     * publishing a fiction.
     */
    reported: boolean;
  };
  /** Every verification verdict, in order. */
  verdicts: {
    pass: boolean;
    by?: string;
    scope?: string;
    id?: string;
    /** True when no verdict could be obtained and the claim passed by default. */
    skipped?: boolean;
    note?: string;
    mustFix?: string[];
  }[];
  /**
   * What the unattended-run guards did. These are the events that distinguish a
   * run that worked from one that spun and was cut off, and they used to reach
   * only the desktop status feed — so `--print --json`, the scriptable channel,
   * reported a clean-looking run for a turn the loop detector had killed.
   *
   * Steers and cuts are counted, not listed: a long run repeats them per turn,
   * and an unbounded array would bury the verdicts it sits next to. Extensions
   * are listed because there are few and each one is a decision.
   */
  guards: {
    /** Corrective steers injected after repeated identical work. */
    loopSteers: number;
    /** Turns cut outright for repetition. */
    loopCuts: number;
    /** Each progress-gated step-cap grant, in order. */
    extensions: { newLimit: number; reason: string }[];
    /**
     * Run-budget spend, when a ceiling was configured. `wrapUpAsked` records
     * that the soft threshold turned into a wrap-up instruction — the
     * difference between a run that chose to finish and one that was cut off,
     * which is otherwise invisible in the result.
     */
    budget?: {
      tokens: number;
      usd: number;
      limitTokens?: number;
      limitUsd?: number;
      wrapUpAsked: boolean;
      breached: boolean;
      /** True when some spend had no catalog price: `usd` is a floor, not a total. */
      unpriced: boolean;
    };
  };
}

/**
 * Run an autonomous goal to completion without the TUI.
 *
 * `--goal` used to reach only the Ink path, so `arterm --print --goal "…"` ran the
 * goal text as a single prompt and silently did something else entirely. It also
 * meant the autonomy loop — and therefore verification — had no scriptable entry
 * point at all, which is why exercising it needed a pty driving a real terminal.
 *
 * Lifecycle goes to stderr so stdout stays the answer, exactly as in `runHeadless`.
 */
export async function runHeadlessGoal(
  session: Session,
  goal: string,
  opts: HeadlessOptions = {},
): Promise<HeadlessGoalResult> {
  if (!goal.trim()) throw new ArtermUserError('No goal provided. Pass one with --goal "…".');

  session.setAsker(async () => "deny");

  const verdicts: HeadlessGoalResult["verdicts"] = [];
  const guards: HeadlessGoalResult["guards"] = { loopSteers: 0, loopCuts: 0, extensions: [] };
  let steps = 0;
  let summary = "";
  let stoppedReason: string | undefined;
  let wrapUpAsked = false;
  const log = (line: string): void => {
    if (!opts.json) process.stderr.write(`${line}\n`);
  };

  const unsubscribe = session.bus.on((event) => {
    switch (event.type) {
      case "autonomy_step":
        steps = event.step;
        log(`▸ step ${event.step}`);
        break;
      case "budget_warning":
        wrapUpAsked = true;
        log(`◔ near the run budget (${event.spent}) — asking the run to wrap up`);
        break;
      case "budget_exceeded":
        log(`■ run budget spent (${event.spent}) — no further requests`);
        break;
      case "autonomy_verify": {
        verdicts.push({
          pass: event.pass,
          ...(event.by ? { by: event.by } : {}),
          ...(event.scope ? { scope: event.scope } : {}),
          ...(event.id ? { id: event.id } : {}),
          ...(event.skipped ? { skipped: true } : {}),
          ...(event.note ? { note: event.note } : {}),
          ...(event.mustFix?.length ? { mustFix: event.mustFix } : {}),
        });
        const where = event.scope && event.scope !== "goal" ? ` ${event.scope}` : "";
        const by = event.by ? ` (${event.by})` : "";
        if (!event.pass) {
          log(`✗ verification failed${by}${where} — ${event.note ?? "criteria not met"}`);
          for (const m of event.mustFix ?? []) log(`  • ${m}`);
        } else if (event.skipped) {
          log(`⚠ verification unavailable — accepting the claim (${event.note ?? "no verdict"})`);
        } else {
          log(`✓ verified${by}${where}${event.note ? ` — ${event.note}` : ""}`);
        }
        break;
      }
      // The loop detector fires twice per repetition — once for the iteration
      // fingerprint, once for the per-call repeat window — so the streak, not
      // the event count, is what the reader should see.
      case "loop_detected":
        guards.loopSteers += 1;
        log(`↻ loop guard: ${event.streak}× the same work — steering`);
        break;
      case "loop_cut":
        guards.loopCuts += 1;
        log(`✂ loop cut after ${event.streak} repetitions — turn ended`);
        break;
      case "autonomy_extended":
        guards.extensions.push({ newLimit: event.newLimit, reason: event.reason });
        log(`⤢ step limit extended to ${event.newLimit} — ${event.reason}`);
        break;
      case "autonomy_done":
        summary = event.summary;
        log("■ goal complete");
        break;
      case "autonomy_stopped":
        stoppedReason = event.reason;
        log(`■ stopped — ${event.reason}`);
        break;
    }
  });

  try {
    await session.autonomy.start(goal);
  } finally {
    unsubscribe();
  }

  // Read the counter at the end rather than tracking spend per event: the
  // budget is the authority on what was spent, and a run with no ceiling has
  // nothing to report — an all-zero block would read as "it cost nothing".
  const spend = session.budgetState?.();
  if (spend && (spend.limitTokens !== undefined || spend.limitUsd !== undefined)) {
    guards.budget = {
      tokens: spend.tokens,
      usd: spend.usd,
      ...(spend.limitTokens !== undefined ? { limitTokens: spend.limitTokens } : {}),
      ...(spend.limitUsd !== undefined ? { limitUsd: spend.limitUsd } : {}),
      wrapUpAsked,
      breached: spend.breached,
      unpriced: spend.unpriced,
    };
  }

  const state = stoppedReason === undefined ? "done" : "stopped";
  const result: HeadlessGoalResult = {
    goal,
    state,
    summary: summary || stoppedReason || "",
    steps,
    usage: {
      inputTokens: spend?.inputTokens ?? 0,
      outputTokens: spend?.outputTokens ?? 0,
      cacheTokens: spend?.cacheTokens ?? 0,
      totalTokens: spend?.tokens ?? 0,
      usd: spend?.usd ?? 0,
      unpriced: spend?.unpriced ?? false,
      reported: spend?.reported ?? false,
    },
    verdicts,
    guards,
  };

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (result.summary) {
    process.stdout.write(`${result.summary}\n`);
  }
  return result;
}
