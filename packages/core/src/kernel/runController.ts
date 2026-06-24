import type { Container } from "./container.js";

/**
 * Owns the lifecycle of a single run: a cancellation signal, an ordered set of
 * teardown disposers, an iteration cap, and an autonomous-continuation flag. It
 * WRAPS `AbortSignal` (it does not replace it), so every existing `signal?.aborted`
 * check keeps working unchanged.
 */
export interface RunHandle {
  /** The single source of truth for cancellation; pass to agent.run / provider streams. */
  readonly signal: AbortSignal;
  /** A per-run child container, so a run can override services without touching root. */
  readonly scope: Container;
  /** Register a disposer; run LIFO by `finish()`. */
  onTeardown(fn: () => void | Promise<void>): void;
  /** Set the per-run iteration cap (today: the agent's maxIterations). */
  iterationLimit(max: number): void;
  getIterationLimit(): number | undefined;
  /** Autonomous-continuation signal: a stage may request another iteration. */
  shouldContinue(): boolean;
  requestContinue(): void;
  /** Cancel the run's signal (idempotent). Teardown runs via `finish()`. */
  abort(reason?: string): void;
  /** Run teardown disposers in LIFO order. Idempotent and never throws. */
  finish(): Promise<void>;
}

export class RunController {
  constructor(private readonly root: Container) {}

  begin(): RunHandle {
    const controller = new AbortController();
    const scope = this.root.createScope();
    const teardowns: (() => void | Promise<void>)[] = [];
    let limit: number | undefined;
    let cont = false;
    let finished = false;

    return {
      signal: controller.signal,
      scope,
      onTeardown(fn) {
        teardowns.push(fn);
      },
      iterationLimit(max) {
        limit = max;
      },
      getIterationLimit() {
        return limit;
      },
      shouldContinue() {
        return cont;
      },
      requestContinue() {
        cont = true;
      },
      abort(reason) {
        if (!controller.signal.aborted) controller.abort(reason);
      },
      async finish() {
        if (finished) return;
        finished = true;
        for (let i = teardowns.length - 1; i >= 0; i--) {
          try {
            await teardowns[i]?.();
          } catch {
            // Teardown must never block a clean shutdown.
          }
        }
      },
    };
  }
}
