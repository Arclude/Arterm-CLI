import { EventBus, PermissionBroker, defaultConfig } from "@arterm/core";
import { render } from "ink-testing-library";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { App } from "./App.js";
import type { Session } from "./types.js";

const tick = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor(view: () => string, pred: (f: string) => boolean, timeout = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (pred(view())) return;
    await tick(20);
  }
  throw new Error(`condition not met within ${timeout}ms; last view:\n${view()}`);
}

function fakeSession(bus: EventBus): Session {
  const noop = (): void => {};
  return {
    agent: {
      model: "fake",
      effectiveContextWindow: () => 8192,
      reset: noop,
      run: async () => {},
      tools: [],
    },
    bus,
    config: { ...defaultConfig() },
    providerLabel: "openai-compat",
    toolCount: 7,
    yolo: false,
    setAsker: noop,
    permissionBroker: new PermissionBroker(bus),
    listModels: async () => [],
    listAllModels: async () => [],
    switchModel: noop,
    switchProvider: noop,
    setApiKey: noop,
    configureOpenAICompat: async () => {},
    removeApiKey: noop,
    signedInProviders: () => [],
    loginProviders: [],
    compact: async () => ({}) as never,
    permissionMode: "ask",
    setMode: noop,
    autonomy: {
      state: "idle",
      start: async () => {},
      pause: noop,
      resume: noop,
      stop: noop,
      steer: noop,
      setMode: () => true,
    },
    sdd: { state: "idle", run: async () => {}, pause: noop, resume: noop, stop: noop },
    mcpServers: [],
    plugins: [],
    skills: [],
    getSkillBody: () => undefined,
  } as unknown as Session;
}

/**
 * What the screen does while a reasoning model reasons.
 *
 * The failure this closes: a backend streaming only `reasoning_content` sends
 * no answer text for as long as it thinks, so the screen sat with a spinner and
 * nothing else — indistinguishable from a hung request, for thirty seconds at a
 * time. The reasoning was already being paid for; it just was not read.
 */
describe("the thinking preview", () => {
  const ui = (frames: string[]) => [...frames].reverse().find((f) => f.includes("ARTERM")) ?? "";

  it("shows the reasoning while it streams", async () => {
    const bus = new EventBus();
    const { frames, unmount } = render(createElement(App, { session: fakeSession(bus) }));
    await tick();

    bus.emit({ type: "turn_start" });
    bus.emit({ type: "thinking_delta", delta: "checking whether the parser exists" });
    await waitFor(
      () => ui(frames),
      (f) => f.includes("THINKING"),
    );
    expect(ui(frames)).toContain("checking whether the parser exists");
    unmount();
  });

  it("gives way to the answer and leaves no trace of itself", async () => {
    // Reasoning is never committed: once the assistant message lands, the
    // transcript is the answer alone.
    const bus = new EventBus();
    const { frames, unmount } = render(createElement(App, { session: fakeSession(bus) }));
    await tick();

    bus.emit({ type: "turn_start" });
    bus.emit({ type: "thinking_delta", delta: "weighing two approaches" });
    await waitFor(
      () => ui(frames),
      (f) => f.includes("weighing two approaches"),
    );

    bus.emit({
      type: "assistant_message",
      message: { role: "assistant", content: "use the first" },
    });
    await waitFor(
      () => ui(frames),
      (f) => f.includes("use the first"),
    );
    expect(ui(frames)).not.toContain("weighing two approaches");
    expect(ui(frames)).not.toContain("THINKING");
    unmount();
  });

  it("holds a constant height as reasoning arrives", async () => {
    // The contract this region shares with the live answer: it is redrawn on
    // every chunk, so one that grows a row leaks the row it grew past into the
    // terminal's scrollback. Long lines are truncated, not wrapped, for the
    // same reason.
    const bus = new EventBus();
    const { frames, unmount } = render(createElement(App, { session: fakeSession(bus) }));
    await tick();

    bus.emit({ type: "turn_start" });
    bus.emit({ type: "thinking_delta", delta: "one\n" });
    await waitFor(
      () => ui(frames),
      (f) => f.includes("THINKING"),
    );
    const short = ui(frames).split("\n").length;

    bus.emit({
      type: "thinking_delta",
      delta: `${"two\nthree\nfour\nfive\n"}${"x".repeat(400)}\n`,
    });
    await waitFor(
      () => ui(frames),
      (f) => f.includes("five"),
    );
    expect(ui(frames).split("\n").length).toBe(short);
    unmount();
  });
});
