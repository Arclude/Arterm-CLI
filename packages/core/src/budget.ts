import { type CatalogModel, cachedCatalogSync, findModelById } from "./modelsDev.js";
import type { TokenUsage } from "./types.js";

/**
 * The run budget: what a whole autonomous run is allowed to spend, as opposed
 * to `budget.turnTokens` (one turn) and `budget.maxIterations` (one turn's
 * loop). Without it the only thing bounding `--autonomous` is the guards —
 * `autoExtend` grows the step cap for as long as progress happens, so a run
 * that keeps making progress toward nothing keeps buying more steps.
 *
 * Cost is the field's chosen stop signal rather than steps, because step count
 * is not comparable across models: one answers in few long steps, another in
 * many short ones, and a step cap tuned for one is meaningless for the other.
 * Tokens stay a first-class limit anyway — a local Ollama or llama.cpp model
 * costs $0, so a USD-only budget would be a no-op exactly where runaway loops
 * are cheapest to start.
 */

/** What a run has spent so far. */
export interface BudgetState {
  tokens: number;
  usd: number;
  /**
   * The same spend split the way an evaluation harness asks for it (Harbor's
   * `AgentContext` wants input/output/cache separately, not one total).
   *
   * Kept beside `tokens` rather than replacing it: `tokens` is what the ceiling
   * is compared against and must stay the priced total, while these three are
   * the vendor's own counters summed verbatim. A provider that reports nothing
   * leaves all three at 0, which is what `reported` below exists to say.
   */
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  /**
   * True when at least one response actually carried token counts.
   *
   * Without it an all-zero report is ambiguous in the one way that matters:
   * a local model that genuinely costs nothing and a backend that reports no
   * usage produce the identical row. That is the same confusion the context
   * gauge had before it stopped trusting reported usage alone — a number that
   * says "nothing" when the truth is "unknown" is worse than no number.
   */
  reported: boolean;
  /** Wall-clock seconds since the run started, whether or not a limit is set. */
  elapsedSec: number;
  /** True once a limit is reached — the run must stop. */
  breached: boolean;
  /** How many times the soft threshold asked for a wrap-up. */
  softHits: number;
  /** Configured ceilings, echoed for reporting. */
  limitTokens?: number;
  limitUsd?: number;
  limitSeconds?: number;
  /** True when at least one priced call had no catalog entry (usd under-counts). */
  unpriced: boolean;
}

export interface RunBudgetOptions {
  /** Hard ceiling on total tokens across the run (prompt + completion + cache). */
  tokens?: number;
  /** Hard ceiling on total USD across the run. */
  usd?: number;
  /**
   * Hard ceiling on WALL-CLOCK seconds across the run.
   *
   * The other two ceilings bound what a run costs; this one bounds what an
   * evaluation harness can take away. Terminal-Bench and its long-horizon
   * successor bound every task by time and kill the process when it expires —
   * the dominant failure mode, 79% of unresolved LH-TB runs — and a killed
   * process writes no result at all. Observed here: a 900s task budget expired,
   * `arterm-result.json` came back 0 bytes, and fifteen minutes of real spend
   * left no token count and no cost behind.
   *
   * Steps cannot stand in for this. `--max-steps 200` was set on that run and
   * never bound, because the constraint was the clock; step duration varies by
   * orders of magnitude across models and tasks, so a step cap tuned to a time
   * limit is a guess that is wrong for the next model.
   *
   * Set it BELOW the harness's own limit. The point is to stop ourselves while
   * we can still report, rather than to be stopped.
   */
  seconds?: number;
  /**
   * Clock source, injectable so the time ceiling is testable without sleeping.
   * Defaults to `Date.now`.
   */
  now?: () => number;
  /**
   * Fraction of a ceiling at which the run is asked to wrap up (default 0.75).
   * Deliberately well below 1: the wrap-up itself costs tokens, and a model
   * told to finish at 99% has no room to finish in.
   */
  softRatio?: number;
  /** Price lookup override (tests). Defaults to the on-disk models.dev cache. */
  catalog?: CatalogModel[];
}

/** Per-1M-token prices for one model, as far as the catalog knows them. */
interface Price {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  known: boolean;
}

function priceFor(catalog: CatalogModel[], model: string, provider: string): Price {
  const meta = findModelById(catalog, model, provider);
  const input = meta?.inputCost ?? 0;
  const output = meta?.outputCost ?? 0;
  return {
    input,
    output,
    // Providers publishing no cache price still bill cached reads at a
    // discount; 10% of input is the rate both major vendors advertise, and
    // guessing low here is the safe direction — it cannot invent spend that
    // did not happen.
    cacheRead: meta?.cacheReadCost ?? input * 0.1,
    cacheWrite: meta?.cacheWriteCost ?? input * 1.25,
    known: meta?.inputCost !== undefined || meta?.outputCost !== undefined,
  };
}

/**
 * USD for one response's usage. Cache reads and writes are priced on their own
 * rates, and which tokens are left to bill at the full input rate follows the
 * provider's declared shape (`cachedInPrompt`) rather than a guess: with
 * prompt ≥ cache the two vendor conventions are indistinguishable from the
 * numbers, and choosing wrong misprices every request in the run.
 */
export function priceUsage(
  usage: TokenUsage,
  model: string,
  provider: string,
  catalog: CatalogModel[] = cachedCatalogSync(),
): { usd: number; tokens: number; priced: boolean } {
  const p = priceFor(catalog, model, provider);
  const cacheRead = usage.cacheReadTokens ?? 0;
  const cacheWrite = usage.cacheWriteTokens ?? 0;
  const prompt = usage.promptTokens ?? 0;
  const completion = usage.completionTokens ?? 0;
  // Tokens billed at the plain input rate: the prompt minus the cached part
  // when the vendor folded it in, the whole prompt when it did not.
  const plainPrompt = usage.cachedInPrompt ? Math.max(0, prompt - cacheRead - cacheWrite) : prompt;
  const usd =
    (plainPrompt * p.input +
      completion * p.output +
      cacheRead * p.cacheRead +
      cacheWrite * p.cacheWrite) /
    1_000_000;
  // Everything the run actually consumed. `totalTokens` is trusted when the
  // vendor reports one (it already reflects that vendor's convention);
  // otherwise the cache is added only when it sits outside the prompt count.
  const outsidePrompt = usage.cachedInPrompt ? 0 : cacheRead + cacheWrite;
  const tokens = usage.totalTokens ?? prompt + completion + outsidePrompt;
  return { usd, tokens, priced: p.known };
}

/**
 * A run's spend counter. One instance per run; sub-agents share the parent's by
 * default so a fleet cannot multiply the bill by spawning workers, and a worker
 * handed its own budget accounts separately (see `child()`).
 */
export class RunBudget {
  private tokens = 0;
  private usd = 0;
  private reportedAny = false;
  private inputTokens = 0;
  private outputTokens = 0;
  private cacheTokens = 0;
  private softHits = 0;
  private announcedSoft = false;
  private unpriced = false;
  private readonly softRatio: number;
  private readonly catalog: CatalogModel[] | undefined;
  private readonly now: () => number;
  private readonly startedAt: number;

  constructor(private readonly opts: RunBudgetOptions = {}) {
    this.softRatio = Math.min(0.99, Math.max(0.1, opts.softRatio ?? 0.75));
    this.catalog = opts.catalog;
    this.now = opts.now ?? Date.now;
    this.startedAt = this.now();
    if (opts.seconds !== undefined) {
      const controller = new AbortController();
      // An injected clock is a test's clock: it does not advance real time, so
      // arming a real timer against it would never fire. Tests assert on
      // `breached` / `inReservePhase`; the signal is for production wall-clock.
      if (!opts.now) {
        const timer = setTimeout(
          () => controller.abort(new Error(`run time budget spent (${opts.seconds}s)`)),
          opts.seconds * 1000,
        );
        timer.unref?.();
      }
      this.deadlineSignal = controller.signal;
    }
  }

  /** True when no ceiling is configured — every check is then a no-op. */
  get inactive(): boolean {
    return (
      this.opts.tokens === undefined &&
      this.opts.usd === undefined &&
      this.opts.seconds === undefined
    );
  }

  /** Wall-clock seconds since construction. Always available, limit or not. */
  get elapsedSec(): number {
    return Math.max(0, (this.now() - this.startedAt) / 1000);
  }

  /**
   * Fires when the time ceiling is reached. `undefined` with no ceiling set.
   *
   * The deadline belongs to the RUN, not to a turn, and that distinction was
   * learned the hard way: a per-turn timer does end the turn it is watching —
   * verified, the abort lands and `run()` reaches its `finally` — and then the
   * autonomy engine makes its NEXT provider call (an assessment, a judge
   * sub-agent) carrying a signal that was never aborted, and the run hangs
   * there instead. Against a server streaming reasoning forever, that read as
   * the deadline having done nothing at all.
   *
   * So the signal lives on the budget, which every agent and sub-agent in the
   * run already shares, and each provider call links it alongside its own.
   *
   * Armed once, in the constructor. Unref'd, so a pending deadline cannot hold
   * the process open past a run that finished early.
   */
  readonly deadlineSignal: AbortSignal | undefined;

  /**
   * Seconds left before the time ceiling, or `undefined` with none configured.
   *
   * This is the half of the mechanism the model is meant to SEE. A deadline it
   * cannot read is one it cannot plan against — it will start a fresh subtask
   * with ninety seconds left exactly as readily as with an hour.
   */
  get remainingSec(): number | undefined {
    if (this.opts.seconds === undefined) return undefined;
    return Math.max(0, this.opts.seconds - this.elapsedSec);
  }

  /** Record one response's usage. Called from the response pipeline, post-spend. */
  spend(usage: TokenUsage, model: string, provider: string): void {
    const priced = priceUsage(usage, model, provider, this.catalog ?? cachedCatalogSync());
    this.tokens += priced.tokens;
    this.usd += priced.usd;
    if (!priced.priced && priced.tokens > 0) this.unpriced = true;
    // Reported split, accumulated verbatim rather than derived from `tokens`:
    // the priced total folds cache reads and writes together at their own
    // rates, which is right for a ceiling and wrong for a usage report.
    this.inputTokens += usage.promptTokens ?? 0;
    this.outputTokens += usage.completionTokens ?? 0;
    this.cacheTokens += (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
    if (usage.promptTokens !== undefined || usage.completionTokens !== undefined) {
      this.reportedAny = true;
    }
  }

  /**
   * True once the run is close enough to its TIME ceiling that it should stop
   * starting work and finalize instead.
   *
   * Time-only on purpose. A token or dollar ceiling is a cost the operator
   * chose and can raise; the clock is enforced from outside by a harness that
   * kills the process, so the consequence of ignoring it is not a bigger bill
   * but an unreported run. Unlike `takeSoftSignal` this is a STATE and not an
   * event: it is read on every request, because a phase the model was told
   * about once is one it has forgotten ten turns later.
   */
  get inReservePhase(): boolean {
    const { seconds } = this.opts;
    return seconds !== undefined && this.elapsedSec >= seconds * this.softRatio;
  }

  /** True once any configured ceiling is reached: the run must stop. */
  get breached(): boolean {
    const { tokens, usd, seconds } = this.opts;
    return (
      (tokens !== undefined && this.tokens >= tokens) ||
      (usd !== undefined && this.usd >= usd) ||
      (seconds !== undefined && this.elapsedSec >= seconds)
    );
  }

  /**
   * True the FIRST time spend crosses the soft threshold — the caller turns
   * that into one wrap-up instruction. Latched, because repeating it every
   * iteration would spend the very budget it is trying to preserve.
   */
  takeSoftSignal(): boolean {
    if (this.breached || this.announcedSoft) return false;
    const { tokens, usd, seconds } = this.opts;
    const over =
      (tokens !== undefined && this.tokens >= tokens * this.softRatio) ||
      (usd !== undefined && this.usd >= usd * this.softRatio) ||
      (seconds !== undefined && this.elapsedSec >= seconds * this.softRatio);
    if (!over) return false;
    this.announcedSoft = true;
    this.softHits += 1;
    return true;
  }

  /** A human-readable line for the stop reason / wrap-up steer. */
  describe(): string {
    const parts: string[] = [];
    if (this.opts.tokens !== undefined) {
      parts.push(
        `${this.tokens.toLocaleString("en-US")}/${this.opts.tokens.toLocaleString("en-US")} tokens`,
      );
    }
    if (this.opts.usd !== undefined) parts.push(`$${this.usd.toFixed(4)}/$${this.opts.usd}`);
    if (this.opts.seconds !== undefined) {
      parts.push(`${Math.round(this.elapsedSec)}s/${this.opts.seconds}s elapsed`);
    }
    if (parts.length === 0) parts.push(`${this.tokens.toLocaleString("en-US")} tokens`);
    return parts.join(", ");
  }

  state(): BudgetState {
    return {
      tokens: this.tokens,
      usd: Number(this.usd.toFixed(6)),
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      cacheTokens: this.cacheTokens,
      reported: this.reportedAny,
      elapsedSec: Number(this.elapsedSec.toFixed(3)),
      breached: this.breached,
      softHits: this.softHits,
      ...(this.opts.tokens !== undefined ? { limitTokens: this.opts.tokens } : {}),
      ...(this.opts.usd !== undefined ? { limitUsd: this.opts.usd } : {}),
      ...(this.opts.seconds !== undefined ? { limitSeconds: this.opts.seconds } : {}),
      unpriced: this.unpriced,
    };
  }

  /**
   * The budget a sub-agent runs on.
   *
   * With no argument the child gets THIS instance — shared accounting, so a
   * fleet's spend rolls up and a parent ceiling bounds the whole tree. Given
   * its own limits the child gets a separate counter, and its breach is that
   * worker's problem rather than the run's: `runSubagent` already returns a
   * failure string instead of throwing, so a budget-stopped worker reads as one
   * that didn't finish, not as a dead run.
   */
  child(own?: RunBudgetOptions): RunBudget {
    if (!own || (own.tokens === undefined && own.usd === undefined && own.seconds === undefined)) {
      return this;
    }
    return new RunBudget({
      ...own,
      softRatio: own.softRatio ?? this.softRatio,
      // The clock is the RUN's, never the worker's. A child counter starts at
      // its own construction, so a fresh `seconds` would hand every sub-agent
      // the full wall-clock allowance again — and a fleet of them would each
      // believe it had the whole budget while the harness clock ran once. The
      // deadline is therefore inherited as what is LEFT, unless the caller
      // deliberately names a shorter one.
      now: this.now,
      ...(own.seconds === undefined && this.remainingSec !== undefined
        ? { seconds: this.remainingSec }
        : {}),
      ...(this.catalog ? { catalog: this.catalog } : {}),
    });
  }
}
