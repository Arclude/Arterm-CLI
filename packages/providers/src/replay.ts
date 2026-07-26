/**
 * Re-issue a streaming request whose connection died before it produced output.
 *
 * `fetchWithRetry` only covers the connection phase: once the server answers
 * 200 and the body starts, a socket death (`TypeError: terminated`,
 * `ECONNRESET`, `UND_ERR_SOCKET`) escaped as a raw error and ended the turn —
 * the single most common way a long generation is lost.
 *
 * Replay is safe exactly while nothing has been yielded yet: no text reached the
 * transcript and no tool call was dispatched, so a second attempt cannot
 * duplicate anything. The moment the first chunk is forwarded, the stream
 * becomes unrepeatable and any later failure propagates.
 */

import { isAbortError, isReplayable, normalizeProviderError } from "@arterm/core";
import { backoffDelay, sleep } from "./retry.js";

/** Extra attempts after the first, when the socket dies before any output. */
const DEFAULT_MAX_REPLAYS = 2;

export interface ReplayOptions {
  /** Caller cancellation — an abort is never retried and never normalized. */
  signal?: AbortSignal;
  /** Extra attempts after the first (default 2). */
  maxReplays?: number;
  /** Injectable for tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/**
 * Run `attempt()` and forward its chunks, restarting it from scratch when it
 * fails with a replayable error before yielding anything.
 *
 * Every failure that escapes is a `ProviderError`, so callers above the provider
 * can route on `kind` / `retryable` instead of matching message strings.
 */
export async function* withStreamReplay<T>(
  provider: string,
  attempt: () => AsyncIterable<T>,
  opts: ReplayOptions = {},
): AsyncGenerator<T> {
  const maxReplays = opts.maxReplays ?? DEFAULT_MAX_REPLAYS;
  const wait = opts.sleep ?? sleep;

  for (let tries = 0; ; tries++) {
    let emitted = false;
    try {
      for await (const chunk of attempt()) {
        emitted = true;
        yield chunk;
      }
      return;
    } catch (err) {
      // A cancelled run is not a failed one — never dress it up as an error the
      // caller might retry.
      if (isAbortError(err) || opts.signal?.aborted) throw err;
      const error = normalizeProviderError(err, provider);
      if (emitted || tries >= maxReplays || !isReplayable(error)) throw error;
      await wait(backoffDelay(tries), opts.signal);
    }
  }
}
