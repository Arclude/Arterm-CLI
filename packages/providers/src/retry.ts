/**
 * Retry wrapper for the connection phase of provider HTTP calls.
 *
 * Only the initial `fetch` (and a non-ok status) is retried — once a streaming
 * body has started being consumed, a retry would duplicate already-yielded
 * output, so mid-stream failures still propagate to the caller. Retryable
 * failures are network errors (fetch rejection) and 408/429/5xx responses;
 * an abort from the caller's signal is never retried.
 */

/** HTTP statuses worth retrying — transient by definition. */
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

/** Hard cap on a single wait, even when Retry-After asks for more. */
const MAX_WAIT_MS = 30_000;

export interface RetryOptions {
  /** Extra attempts after the first (default 3). */
  retries?: number;
  /** First backoff delay; doubles per attempt with jitter (default 500ms). */
  baseDelayMs?: number;
  /** Abort waiting (and give up) when this fires. */
  signal?: AbortSignal;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests — resolves after ms or rejects on abort. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
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
    // Don't keep the process alive just to wait out a backoff.
    timer.unref?.();
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
function delayFor(attempt: number, baseDelayMs: number, retryAfter: string | null): number {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, MAX_WAIT_MS);
    }
    const dateMs = Date.parse(retryAfter) - Date.now();
    if (Number.isFinite(dateMs) && dateMs > 0) return Math.min(dateMs, MAX_WAIT_MS);
  }
  // Full-jitter exponential backoff: uniform in [0, base * 2^attempt].
  const cap = Math.min(baseDelayMs * 2 ** attempt, MAX_WAIT_MS);
  return Math.random() * cap;
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
  const doFetch = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      await sleep(delayFor(attempt - 1, baseDelayMs, retryAfterOf(lastError)), opts.signal);
    }
    try {
      const res = await doFetch(url, init);
      if (res.ok || !RETRYABLE_STATUS.has(res.status)) return res;
      if (attempt === retries) return res;
      // Drain the failed body so the connection can be reused, then back off.
      const detail = await res.text().catch(() => "");
      lastError = new RetryableStatusError(res.status, detail, res.headers.get("retry-after"));
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
