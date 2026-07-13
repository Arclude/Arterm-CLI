import type { Session } from "@arterm/tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MEMBER_ACTIVITY_MAX, RING_MAX, StatusState, control } from "./statusState.js";

// Minimal stand-ins so the test pulls no workspace runtime deps (the `Session`
// and `AgentEvent` imports in statusState.ts are type-only and erased at runtime).
type Listener = (event: { type: string; [k: string]: unknown }) => void;

class FakeBus {
  private readonly listeners = new Set<Listener>();
  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(event: { type: string; [k: string]: unknown }): void {
    for (const listener of this.listeners) listener(event);
  }
}

function makeAutonomy(state = "idle") {
  return {
    state,
    snapshot: vi.fn(() => ({ state, mode: "once", goal: "", step: 0, phases: [], team: [] })),
    pause: vi.fn(),
    resume: vi.fn(),
    stop: vi.fn(),
    steer: vi.fn(),
    start: vi.fn().mockResolvedValue(undefined),
    setMode: vi.fn(() => true),
  };
}

function makeSession(autonomy = makeAutonomy()) {
  const bus = new FakeBus();
  const session = {
    bus,
    agent: { model: "test-model" },
    providerLabel: "test-provider",
    permissionMode: "ask",
    toolCount: 7,
    autonomy,
  };
  return { bus, autonomy, session: session as unknown as Session };
}

describe("StatusState", () => {
  it("tracks status transitions through a turn", () => {
    const { bus, session } = makeSession();
    const state = new StatusState(session, { sessionId: "s1", cwd: "/w" });

    expect(state.snapshot().status).toBe("idle");
    bus.emit({ type: "turn_start" });
    expect(state.snapshot().status).toBe("thinking");
    bus.emit({ type: "tool_call", call: { id: "c1", name: "read", arguments: {} } });
    const during = state.snapshot();
    expect(during.status).toBe("tool");
    expect(during.activeTool).toBe("read");
    bus.emit({ type: "tool_result", callId: "c1", name: "read", output: "" });
    expect(state.snapshot().status).toBe("thinking");
    bus.emit({ type: "turn_end" });
    const after = state.snapshot();
    expect(after.status).toBe("idle");
    expect(after.activeTool).toBeNull();
    state.dispose();
  });

  it("accumulates token usage and carries session identity", () => {
    const { bus, session } = makeSession();
    const state = new StatusState(session, { sessionId: "s1", cwd: "/w" });

    bus.emit({ type: "usage", usage: { promptTokens: 100, completionTokens: 20 } });
    bus.emit({ type: "usage", usage: { promptTokens: 150, completionTokens: 30 } });
    const snap = state.snapshot();
    expect(snap.tokens).toEqual({ in: 250, out: 50, ctx: 150 });
    expect(snap.v).toBe(1);
    expect(snap.pid).toBe(process.pid);
    expect(snap.sessionId).toBe("s1");
    expect(snap.cwd).toBe("/w");
    expect(snap.model).toBe("test-model");
    expect(snap.provider).toBe("test-provider");
    state.dispose();
  });

  it("accumulates the team board per the contract semantics", () => {
    const { bus, session } = makeSession();
    const state = new StatusState(session, { sessionId: "s1", cwd: "/w" });

    bus.emit({
      type: "team_plan",
      members: [
        { id: "m1", name: "reviewer", description: "reviews", adhoc: false },
        { id: "m2", name: "coder", description: "codes", adhoc: true },
      ],
    });
    expect(state.snapshot().team).toHaveLength(2);
    expect(state.snapshot().team[0]?.state).toBe("pending");

    bus.emit({
      type: "team_member_state",
      id: "m1",
      name: "reviewer",
      state: "running",
      task: "review PR",
    });
    bus.emit({
      type: "team_member_event",
      id: "m1",
      name: "reviewer",
      event: { type: "tool_call", call: { id: "c1", name: "grep", arguments: {} } },
    });
    let m1 = state.snapshot().team.find((m) => m.id === "m1");
    expect(m1?.state).toBe("running");
    expect(m1?.task).toBe("review PR");
    expect(m1?.activity).toBe("⚙ grep");
    expect(m1?.toolUseCount).toBe(1);
    expect(m1?.recentActivities).toEqual(["⚙ grep"]);
    expect(m1?.startedAt).toBeGreaterThan(0);

    // Per-member usage accumulates into tokenCount.
    bus.emit({
      type: "team_member_event",
      id: "m1",
      name: "reviewer",
      event: { type: "usage", usage: { promptTokens: 40, completionTokens: 10 } },
    });
    m1 = state.snapshot().team.find((m) => m.id === "m1");
    expect(m1?.tokenCount).toBe(50);
    expect(m1?.toolUseCount).toBe(1); // usage is not a tool call

    // Re-asserting running keeps the last activity…
    bus.emit({ type: "team_member_state", id: "m1", name: "reviewer", state: "running" });
    m1 = state.snapshot().team.find((m) => m.id === "m1");
    expect(m1?.activity).toBe("⚙ grep");

    // …but leaving running clears it.
    bus.emit({
      type: "team_member_state",
      id: "m1",
      name: "reviewer",
      state: "done",
      filesChanged: 3,
    });
    m1 = state.snapshot().team.find((m) => m.id === "m1");
    expect(m1?.state).toBe("done");
    expect(m1?.activity).toBeUndefined();
    expect(m1?.filesChanged).toBe(3);

    // A new plan resets the board.
    bus.emit({
      type: "team_plan",
      members: [{ id: "m9", name: "x", description: "", adhoc: false }],
    });
    expect(state.snapshot().team).toHaveLength(1);
    expect(state.snapshot().team[0]?.id).toBe("m9");
    state.dispose();
  });

  it("tracks the main agent as a first-class node (tool count + recent activities)", () => {
    const { bus, session } = makeSession();
    const state = new StatusState(session, { sessionId: "s1", cwd: "/w" });

    expect(state.snapshot().main).toEqual({
      toolUseCount: 0,
      recentActivities: [],
    });

    bus.emit({ type: "tool_call", call: { id: "c1", name: "read", arguments: {} } });
    bus.emit({ type: "assistant_message", content: "hi" });
    const snap = state.snapshot();
    expect(snap.main.toolUseCount).toBe(1); // usage/messages are not tool calls
    expect(snap.main.recentActivities).toEqual(["⚙ read", "✎ writing"]);

    // Recent activities are capped like a member's (newest last).
    for (let i = 0; i < MEMBER_ACTIVITY_MAX + 2; i++) {
      bus.emit({ type: "tool_call", call: { id: `t${i}`, name: `tool${i}`, arguments: {} } });
    }
    const capped = state.snapshot().main;
    expect(capped.recentActivities).toHaveLength(MEMBER_ACTIVITY_MAX);
    expect(capped.recentActivities.at(-1)).toBe(`⚙ tool${MEMBER_ACTIVITY_MAX + 1}`);
    expect(capped.toolUseCount).toBe(1 + MEMBER_ACTIVITY_MAX + 2);
    state.dispose();
  });

  it("keeps text_delta out of the ring and caps it at RING_MAX", () => {
    const { bus, session } = makeSession();
    const state = new StatusState(session, { sessionId: "s1", cwd: "/w" });

    bus.emit({ type: "text_delta", delta: "x" });
    expect(state.events()).toHaveLength(0);

    for (let i = 0; i < RING_MAX + 5; i++) bus.emit({ type: "assistant_message", content: "m" });
    const events = state.events();
    expect(events).toHaveLength(RING_MAX);
    expect(events[0]?.seq).toBe(6); // first five evicted
    expect(state.events(RING_MAX)).toHaveLength(5); // since-filter
    state.dispose();
  });

  it("computes activeAgents from main status, team, workers, and fleet", () => {
    const { bus, session } = makeSession();
    const state = new StatusState(session, { sessionId: "s1", cwd: "/w" });
    expect(state.snapshot().activeAgents).toBe(0);

    bus.emit({ type: "turn_start" }); // main agent busy
    bus.emit({
      type: "team_plan",
      members: [{ id: "m1", name: "a", description: "", adhoc: false }],
    });
    bus.emit({ type: "team_member_state", id: "m1", name: "a", state: "running" });
    bus.emit({ type: "subagent_start", task: "t1" });
    bus.emit({ type: "fleet_start", count: 2 });
    expect(state.snapshot().activeAgents).toBe(5); // 1 main + 1 team + 1 worker + 2 fleet

    bus.emit({ type: "subagent_done", output: "ok" });
    bus.emit({ type: "fleet_done", count: 2 });
    bus.emit({ type: "team_member_state", id: "m1", name: "a", state: "done" });
    bus.emit({ type: "turn_end" });
    expect(state.snapshot().activeAgents).toBe(0);
    state.dispose();
  });

  it("counts the main agent when autonomy is running even between turns", () => {
    const { session } = makeSession(makeAutonomy("running"));
    const state = new StatusState(session, { sessionId: "s1", cwd: "/w" });
    expect(state.snapshot().activeAgents).toBe(1);
    state.dispose();
  });

  describe("throttled fanout", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("coalesces state pushes and forwards each event immediately", () => {
      const { bus, session } = makeSession();
      const state = new StatusState(session, { sessionId: "s1", cwd: "/w" });
      const received: string[] = [];
      state.addSubscriber((msg) => received.push(msg.kind));

      bus.emit({ type: "turn_start" });
      bus.emit({ type: "assistant_message", content: "a" });
      bus.emit({ type: "turn_end" });
      expect(received).toEqual(["event", "event", "event"]);

      vi.advanceTimersByTime(300);
      expect(received.filter((k) => k === "state")).toHaveLength(1);
      state.dispose();
    });
  });
});

describe("control", () => {
  it("dispatches pause/resume/stop to the autonomy engine", () => {
    const { session, autonomy } = makeSession();
    expect(control(session, "pause", "")).toEqual({ ok: true });
    expect(control(session, "resume", "")).toEqual({ ok: true });
    expect(control(session, "stop", "")).toEqual({ ok: true });
    expect(autonomy.pause).toHaveBeenCalled();
    expect(autonomy.resume).toHaveBeenCalled();
    expect(autonomy.stop).toHaveBeenCalled();
  });

  it("requires text for steer and goal", () => {
    const { session, autonomy } = makeSession();
    expect(control(session, "steer", "").ok).toBe(false);
    expect(control(session, "goal", "").ok).toBe(false);
    expect(control(session, "steer", "go left")).toEqual({ ok: true });
    expect(control(session, "goal", "ship it")).toEqual({ ok: true });
    expect(autonomy.steer).toHaveBeenCalledWith("go left");
    expect(autonomy.start).toHaveBeenCalledWith("ship it");
  });

  it("validates mode and surfaces mid-run rejection", () => {
    const { session, autonomy } = makeSession();
    expect(control(session, "mode", "", "bogus").ok).toBe(false);
    expect(control(session, "mode", "", "team")).toEqual({ ok: true });
    expect(autonomy.setMode).toHaveBeenCalledWith("team");

    autonomy.setMode.mockReturnValueOnce(false);
    const rejected = control(session, "mode", "", "once");
    expect(rejected.ok).toBe(false);
    expect(rejected.error).toMatch(/mid-run/);
  });

  it("rejects unknown actions", () => {
    const { session } = makeSession();
    const result = control(session, "explode", "");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("explode");
  });
});
