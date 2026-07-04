import { describe, expect, it, vi } from "vitest";
import { EventBus } from "./eventBus.js";

describe("EventBus", () => {
  it("delivers events to every subscriber", () => {
    const bus = new EventBus();
    const seen: string[] = [];
    bus.on((e) => seen.push(`a:${e.type}`));
    bus.on((e) => seen.push(`b:${e.type}`));
    bus.emit({ type: "turn_start" });
    expect(seen).toEqual(["a:turn_start", "b:turn_start"]);
  });

  it("stops delivering to an unsubscribed listener", () => {
    const bus = new EventBus();
    const fn = vi.fn();
    const off = bus.on(fn);
    off();
    bus.emit({ type: "turn_start" });
    expect(fn).not.toHaveBeenCalled();
  });

  it("isolates a throwing listener: emit does not throw and others still run", () => {
    const onListenerError = vi.fn();
    const bus = new EventBus(onListenerError);
    const after = vi.fn();
    const boom = new Error("subscriber blew up");
    bus.on(() => {
      throw boom;
    });
    bus.on(after);

    expect(() => bus.emit({ type: "turn_start" })).not.toThrow();
    expect(after).toHaveBeenCalledTimes(1);
    expect(onListenerError).toHaveBeenCalledWith(boom, { type: "turn_start" });
  });

  it("swallows a listener error by default (no handler supplied) without ARTERM_DEBUG", () => {
    const bus = new EventBus();
    bus.on(() => {
      throw new Error("nope");
    });
    // With no custom handler and ARTERM_DEBUG unset, emit must still be safe.
    expect(() => bus.emit({ type: "error", error: "x" })).not.toThrow();
  });
});
