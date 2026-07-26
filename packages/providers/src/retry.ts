/**
 * Retry wrapper for the connection phase of provider HTTP calls.
 *
 * Only the initial `fetch` (and a non-ok status) is retried — once a streaming
 * body has started being consumed, a retry would duplicate already-yielded
 * output, so mid-stream failures still propagate to the caller. Retryable
 * failures are network errors (fetch rejection) and 408/429/5xx responses;
 * an abort from the caller's signal is never retried.
 *
 * When the server states how long it will keep refusing (`Retry-After`) and that
 * is longer than {@link MAX_WAIT_MS}, retrying stops immediately — see
 * `exceedsWaitBudget`.
 */

import { parseRetryAfter } from "@arterm/core";

/** HTTP statuses worth retrying — transient by definition. 529 is "overloaded". */
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504, 529]);

/**
 * The longest we are willing to sit inside one backoff. Doubles as the retry
 * budget: a `Retry-After` above this means retrying here is pointless.
 */
const MAX_WAIT_MS = 30_000;

export interface RetryOptions {
  /** Extra attempts after the first (default 3). */
  retries?: number;
  /** First backoff delay; doubles per attempt with jitter (default 500ms). */
  baseDelayMs?: number;
  /**
   * Longest single wait, and the `Retry-After` above which retrying is abandoned
   * (default 30s).
   */
  maxWaitMs?: number;
  /** Abort waiting (and give up) when this fires. */
  signal?: AbortSignal;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests — resolves after ms or rejects on abort. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** Wait `ms`, rejecting if `signal` fires first. Exported for stream replay backoff. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return defaultSleep(ms, signal);
}

/** Full-jitter exponential backoff for attempt `n` (0-based). */
export function backoffDelay(attempt: number, baseDelayMs = 500): number {
  return delayFor(attempt, baseDelayMs, null, MAX_WAIT_MS);
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    // Deliberately NOT unref'd. A backoff is a turn in progress, and this timer
    // is often the only thing left holding the event loop open — the dead socket
    // that caused the retry holds nothing. Unref'ing it let `arterm --print`
    // exit 0 mid-backoff: no answer, no error, no retry, silent success.
    // Cancellation is `signal`'s job, not the loop's.
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function abortError(signal?: AbortSignal): unknown {
  return signal?.reason ?? new DOMException("This operation was aborted", "AbortError");
}

function isAbort(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  return err instanceof DOMException && err.name === "AbortError";
}

/** Delay before attempt `n` (0-based), honoring a Retry-After header when given. */
function delayFor(
  attempt: number,
  baseDelayMs: number,
  retryAfter: string | null,
  maxWaitMs: number,
): number {
  const asked = parseRetryAfter(retryAfter);
  if (asked !== null) return Math.min(asked, maxWaitMs);
  // Full-jitter exponential backoff: uniform in [0, base * 2^attempt].
  const cap = Math.min(baseDelayMs * 2 ** attempt, maxWaitMs);
  return Math.random() * cap;
}

/**
 * Whether the server's `Retry-After` is longer than we are prepared to wait.
 *
 * When it is, retrying is pure delay dressed up as resilience: clamping the wait
 * to 30s does not make a one-hour rate limit clear any sooner — it just buys the
 * same refusal three more times, 90 seconds later. Giving up now lets the
 * fallback chain reach a model that will actually answer, and a user with no
 * chain configured sees an accurate "rate limited for 58m" immediately instead
 * of after a minute and a half of silent waiting.
 */
function exceedsWaitBudget(retryAfter: string | null, maxWaitMs: number): boolean {
  const asked = parseRetryAfter(retryAfter);
  return asked !== null && asked > maxWaitMs;
}

/**
 * `fetch` with retries on transient failures. Returns the first ok (or
 * non-retryable) response; throws the last error once attempts are exhausted.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  opts: RetryOptions = {},
): Promise<Response> {
  const retries = opts.retries ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 500;
  const maxWaitMs = opts.maxWaitMs ?? MAX_WAIT_MS;
  const doFetch = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      await sleep(
        delayFor(attempt - 1, baseDelayMs, retryAfterOf(lastError), maxWaitMs),
        opts.signal,
      );
    }
    try {
      const res = await doFetch(url, init);
      if (res.ok || !RETRYABLE_STATUS.has(res.status)) return res;
      if (attempt === retries) return res;
      const retryAfter = res.headers.get("retry-after");
      // Hand the response back unread: the caller turns it into a ProviderError
      // whose detail comes from the body, and the fallback chain switches models
      // now rather than after three doomed attempts.
      if (exceedsWaitBudget(retryAfter, maxWaitMs)) return res;
      // Drain the failed body so the connection can be reused, then back off.
      const detail = await res.text().catch(() => "");
      lastError = new RetryableStatusError(res.status, detail, retryAfter);
    } catch (err) {
      if (isAbort(err, opts.signal)) throw err;
      if (attempt === retries) throw err;
      lastError = err;
    }
  }
  // Unreachable: the loop always returns or throws on the last attempt.
  throw lastError;
}

/** Carries the Retry-After hint from a retryable status to the backoff logic. */
class RetryableStatusError extends Error {
  constructor(
    readonly status: number,
    detail: string,
    readonly retryAfter: string | null,
  ) {
    super(`HTTP ${status}${detail ? ` ${detail}` : ""}`);
  }
}

function retryAfterOf(err: unknown): string | null {
  return err instanceof RetryableStatusError ? err.retryAfter : null;
}
