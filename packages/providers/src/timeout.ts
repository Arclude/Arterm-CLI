/**
 * An idle-timeout guard for streaming requests. The returned `signal` aborts when
 * either the upstream (caller) signal aborts OR no `reset()` happens within `ms` —
 * so a hung server that accepts the connection but never sends bytes can't block a
 * turn forever. Call `reset()` on every received chunk and `clear()` when done.
 */
export interface StreamGuard {
  signal: AbortSignal;
  reset(): void;
  clear(): void;
}

export function streamIdleGuard(ms: number, upstream?: AbortSignal): StreamGuard {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const onUpstreamAbort = () => {
    if (timer) clearTimeout(timer);
    controller.abort(upstream?.reason);
  };
  const arm = () => {
    timer = setTimeout(() => controller.abort(new Error(`stream idle: no data for ${ms}ms`)), ms);
    // Don't keep the event loop alive just for this timer.
    timer.unref?.();
  };

  if (upstream) {
    if (upstream.aborted) controller.abort(upstream.reason);
    else upstream.addEventListener("abort", onUpstreamAbort, { once: true });
  }
  if (!controller.signal.aborted) arm();

  return {
    signal: controller.signal,
    reset() {
      if (timer) clearTimeout(timer);
      if (!controller.signal.aborted) arm();
    },
    clear() {
      if (timer) clearTimeout(timer);
      if (upstream) upstream.removeEventListener("abort", onUpstreamAbort);
    },
  };
}
