import { PermissionBroker, type Tool } from "@arterm/core";
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
  const permissionBroker = new PermissionBroker();
  const session = {
    bus,
    agent: { model: "test-model" },
    providerLabel: "test-provider",
    permissionMode: "ask",
    toolCount: 7,
    autonomy,
    permissionBroker,
  };
  return { bus, autonomy, permissionBroker, session: session as unknown as Session };
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

  it("surfaces a failed turn as lastError with the provider taxonomy", () => {
    const { bus, session } = makeSession();
    const state = new StatusState(session, { sessionId: "s1", cwd: "/w" });

    expect(state.snapshot().lastError).toBeNull();
    bus.emit({ type: "turn_start" });
    bus.emit({
      type: "error",
      error: "anthropic: rate limited",
      kind: "quota",
      provider: "anthropic",
      status: 429,
      retryable: true,
    });
    bus.emit({ type: "turn_end" });

    // The give-away failure mode this guards: status is back to "idle", so a
    // client reading only `status` would call this session healthy.
    const after = state.snapshot();
    expect(after.status).toBe("idle");
    expect(after.lastError).toMatchObject({
      message: "anthropic: rate limited",
      kind: "quota",
      provider: "anthropic",
      status: 429,
      retryable: true,
    });
    expect(after.lastError?.at).toBeGreaterThan(0);
    state.dispose();
  });

  it("clears lastError when the next turn starts", () => {
    const { bus, session } = makeSession();
    const state = new StatusState(session, { sessionId: "s1", cwd: "/w" });

    bus.emit({ type: "error", error: "boom" });
    bus.emit({ type: "turn_end" });
    expect(state.snapshot().lastError).not.toBeNull();
    bus.emit({ type: "turn_start" });
    expect(state.snapshot().lastError).toBeNull();
    state.dispose();
  });

  it("keeps the last fallback switch across turns", () => {
    const { bus, session } = makeSession();
    const state = new StatusState(session, { sessionId: "s1", cwd: "/w" });

    expect(state.snapshot().lastFallback).toBeNull();
    bus.emit({
      type: "provider_fallback",
      from: { provider: "anthropic", model: "claude-opus-5" },
      to: { provider: "ollama", model: "qwen3" },
      reason: "quota",
      detail: "HTTP 429",
    });
    bus.emit({ type: "turn_end" });
    // Unlike lastError, this outlives the turn: the session is still answering
    // from the backup model, which is worth showing until it switches back.
    bus.emit({ type: "turn_start" });
    expect(state.snapshot().lastFallback).toMatchObject({
      to: { provider: "ollama", model: "qwen3" },
      reason: "quota",
    });
    state.dispose();
  });

  it("accumulates token usage and carries session identity", () => {
    const { bus, session } = makeSession();
    const state = new StatusState(session, { sessionId: "s1", cwd: "/w" });

    bus.emit({ type: "usage", usage: { promptTokens: 100, completionTokens: 20 } });
    bus.emit({ type: "usage", usage: { promptTokens: 150, completionTokens: 30 } });
    const snap = state.snapshot();
    // in/out accumulate across the run; `ctx` is no longer derived from usage —
    // see the context test below for why.
    expect(snap.tokens).toEqual({ in: 250, out: 50, ctx: 0 });
    expect(snap.v).toBe(1);
    expect(snap.pid).toBe(process.pid);
    expect(snap.sessionId).toBe("s1");
    expect(snap.cwd).toBe("/w");
    expect(snap.model).toBe("test-model");
    expect(snap.provider).toBe("test-provider");
    state.dispose();
  });

  it("takes context fullness from the agent, not from reported usage", () => {
    // A provider that reports no usage left `ctx` at 0 forever while the
    // context filled up — a meter reading "empty" right until the agent
    // compacts. The agent now publishes the figure it actually acts on
    // (reported when available, estimated otherwise), window included.
    const { bus, session } = makeSession();
    const state = new StatusState(session, { sessionId: "s1", cwd: "/w" });

    bus.emit({ type: "context_usage", used: 12_000, window: 200_000, estimated: true });
    expect(state.snapshot().tokens).toMatchObject({ ctx: 12_000, ctxWindow: 200_000 });

    bus.emit({ type: "context_compacted", before: 40, after: 8, reason: "auto" });
    expect(state.snapshot().tokens.ctx).toBe(0);
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
    expect(control(session, { action: "pause" })).toEqual({ ok: true });
    expect(control(session, { action: "resume" })).toEqual({ ok: true });
    expect(control(session, { action: "stop" })).toEqual({ ok: true });
    expect(autonomy.pause).toHaveBeenCalled();
    expect(autonomy.resume).toHaveBeenCalled();
    expect(autonomy.stop).toHaveBeenCalled();
  });

  it("requires text for steer and goal", () => {
    const { session, autonomy } = makeSession();
    expect(control(session, { action: "steer" }).ok).toBe(false);
    expect(control(session, { action: "goal" }).ok).toBe(false);
    expect(control(session, { action: "steer", note: "go left" })).toEqual({ ok: true });
    expect(control(session, { action: "goal", note: "ship it" })).toEqual({ ok: true });
    expect(autonomy.steer).toHaveBeenCalledWith("go left");
    expect(autonomy.start).toHaveBeenCalledWith("ship it");
  });

  it("validates mode and surfaces mid-run rejection", () => {
    const { session, autonomy } = makeSession();
    expect(control(session, { action: "mode", mode: "bogus" }).ok).toBe(false);
    expect(control(session, { action: "mode", mode: "team" })).toEqual({ ok: true });
    expect(autonomy.setMode).toHaveBeenCalledWith("team");

    autonomy.setMode.mockReturnValueOnce(false);
    const rejected = control(session, { action: "mode", mode: "once" });
    expect(rejected.ok).toBe(false);
    expect(rejected.error).toMatch(/mid-run/);
  });

  it("rejects unknown actions", () => {
    const { session } = makeSession();
    const result = control(session, { action: "explode" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("explode");
  });
});

describe("control: permission", () => {
  const writeTool = {
    name: "write_file",
    description: "writes",
    parameters: { type: "object" },
    permission: "ask",
    category: "edit",
    riskTier: "destructive",
    preview: (args: Record<string, unknown>) => `write ${String(args.path)}`,
    execute: async () => ({ output: "" }),
  } as unknown as Tool;

  it("answers the pending request and surfaces it in the snapshot", async () => {
    const { session, permissionBroker } = makeSession();
    const state = new StatusState(session, { sessionId: "s1", cwd: "/w" });
    // No local asker installed → the broker's default denies immediately, so
    // install one that never settles: this test is about the remote answer.
    permissionBroker.setAsker(() => new Promise(() => {}));

    const answer = permissionBroker.ask(writeTool, { path: "a.ts" });
    const snap = state.snapshot();
    expect(snap.pendingPermission).toMatchObject({
      tool: "write_file",
      preview: "write a.ts",
      category: "edit",
      riskTier: "destructive",
    });
    expect(snap.pendingPermissionQueue).toBe(0);

    const id = snap.pendingPermission?.id ?? "";
    expect(control(session, { action: "permission", id, answer: "allow" })).toEqual({ ok: true });
    await expect(answer).resolves.toBe("allow");
    expect(state.snapshot().pendingPermission).toBeNull();
    state.dispose();
  });

  it("validates id and answer", () => {
    const { session, permissionBroker } = makeSession();
    permissionBroker.setAsker(() => new Promise(() => {}));

    expect(control(session, { action: "permission", answer: "allow" }).ok).toBe(false);
    // Nothing pending yet.
    expect(control(session, { action: "permission", id: "x", answer: "allow" }).error).toMatch(
      /no permission request/,
    );

    void permissionBroker.ask(writeTool, { path: "a.ts" });
    const id = permissionBroker.current()?.id ?? "";
    expect(control(session, { action: "permission", id, answer: "maybe" }).ok).toBe(false);
    expect(control(session, { action: "permission", id: "stale", answer: "allow" }).error).toMatch(
      /stale/,
    );
    expect(control(session, { action: "permission", id, answer: "deny" })).toEqual({ ok: true });
  });
});
