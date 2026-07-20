import { EventBus } from "@arterm/core";
import { describe, expect, it } from "vitest";
import { SessionMeta } from "./sessionMeta.js";
import type { Session } from "./types.js";

function metaWithBus(): { bus: EventBus; meta: SessionMeta } {
  const bus = new EventBus();
  const meta = new SessionMeta({ bus } as unknown as Session);
  return { bus, meta };
}

describe("SessionMeta", () => {
  it("tracks the turn lifecycle: thinking → tool → idle, counting rounds", () => {
    const { bus, meta } = metaWithBus();
    expect(meta.get().status).toBe("idle");

    bus.emit({ type: "turn_start" });
    expect(meta.get().status).toBe("thinking");

    bus.emit({
      type: "tool_call",
      call: { id: "1", name: "read_file", arguments: {} },
    });
    expect(meta.get().status).toBe("tool");
    expect(meta.get().activeTool).toBe("read_file");

    bus.emit({
      type: "tool_result",
      callId: "1",
      name: "read_file",
      output: "",
      isError: false,
    });
    expect(meta.get().status).toBe("thinking");
    expect(meta.get().activeTool).toBeUndefined();

    bus.emit({ type: "turn_end" });
    expect(meta.get().status).toBe("idle");
    expect(meta.get().rounds).toBe(1);
  });

  it("tracks autonomy runs and their goal text", () => {
    const { bus, meta } = metaWithBus();
    bus.emit({ type: "goal_set", goal: "fix the tests", mode: "once" });
    expect(meta.get().autonomyRunning).toBe(true);
    expect(meta.get().goal).toBe("fix the tests");

    bus.emit({ type: "autonomy_paused" });
    expect(meta.get().autonomyRunning).toBe(false);
    expect(meta.get().goal).toBe("fix the tests");

    bus.emit({ type: "autonomy_resumed" });
    expect(meta.get().autonomyRunning).toBe(true);

    bus.emit({ type: "autonomy_done", summary: "done" });
    expect(meta.get().autonomyRunning).toBe(false);
    expect(meta.get().goal).toBeUndefined();
  });

  it("notifies subscribers and stops after dispose", () => {
    const { bus, meta } = metaWithBus();
    let calls = 0;
    meta.subscribe(() => {
      calls++;
    });
    bus.emit({ type: "turn_start" });
    expect(calls).toBe(1);

    meta.dispose();
    bus.emit({ type: "turn_end" });
    expect(calls).toBe(1);
    expect(meta.get().status).toBe("thinking"); // frozen at dispose time
  });
});
