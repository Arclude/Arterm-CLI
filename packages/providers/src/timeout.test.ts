import { describe, expect, it, vi } from "vitest";
import { streamIdleGuard } from "./timeout.js";

describe("streamIdleGuard", () => {
  it("aborts when idle past the timeout", () => {
    vi.useFakeTimers();
    const g = streamIdleGuard(1000);
    expect(g.signal.aborted).toBe(false);
    vi.advanceTimersByTime(1001);
    expect(g.signal.aborted).toBe(true);
    g.clear();
    vi.useRealTimers();
  });

  it("reset() postpones the timeout", () => {
    vi.useFakeTimers();
    const g = streamIdleGuard(1000);
    vi.advanceTimersByTime(900);
    g.reset();
    vi.advanceTimersByTime(900);
    expect(g.signal.aborted).toBe(false); // reset bought another full window
    vi.advanceTimersByTime(200);
    expect(g.signal.aborted).toBe(true);
    g.clear();
    vi.useRealTimers();
  });

  it("is already aborted when the upstream signal is", () => {
    const g = streamIdleGuard(1000, AbortSignal.abort());
    expect(g.signal.aborted).toBe(true);
    g.clear();
  });

  it("propagates a later upstream abort", () => {
    const ctrl = new AbortController();
    const g = streamIdleGuard(1000, ctrl.signal);
    expect(g.signal.aborted).toBe(false);
    ctrl.abort();
    expect(g.signal.aborted).toBe(true);
    g.clear();
  });
});
