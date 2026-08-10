import { EventBus, PermissionBroker, type TodoItem, defaultConfig } from "@arterm/core";
import { render } from "ink-testing-library";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { App } from "./App.js";
import type { Session } from "./types.js";

/**
 * Separate from `todoStrip.test.tsx` on purpose: importing `App.js` pulls in
 * the chrome that turns colour ON, and the component file asserts on the first
 * character of a rendered row — which becomes an escape byte for every row the
 * moment colour is enabled. A pure-component test and a wired-App test cannot
 * share a module environment here.
 */
const tick = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor(view: () => string, pred: (f: string) => boolean, timeout = 20_000) {
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

const items = (n: number, activeAt = -1): TodoItem[] =>
  Array.from({ length: n }, (_, i) => ({
    id: String(i + 1),
    text: `step ${i + 1}`,
    status: i === activeAt ? "in_progress" : i < activeAt ? "done" : "pending",
  }));

const done = (n: number): TodoItem[] =>
  Array.from({ length: n }, (_, i) => ({
    id: String(i + 1),
    text: `step ${i + 1}`,
    status: "done",
  }));

/**
 * The strip is chrome, and chrome that outlives its subject reads as a UI that
 * is stuck: the store's contract says an empty list clears the display, but a
 * model finishes by marking items DONE, so three green rows and a `5/5` stayed
 * pinned above the status bar for the rest of the session.
 */
describe("a finished list leaves the screen", () => {
  it("clears the strip and leaves a receipt in the transcript", async () => {
    const bus = new EventBus();
    const { frames, unmount } = render(createElement(App, { session: fakeSession(bus) }));
    const ui = () => [...frames].reverse().find((f) => f.includes("ARTERM")) ?? "";
    await tick();

    bus.emit({ type: "todo_changed", items: items(3, 1) });
    await waitFor(ui, (f) => f.includes("1/3"));

    bus.emit({ type: "todo_changed", items: done(3) });
    await waitFor(ui, (f) => f.includes("todo list complete — 3/3"));
    expect(ui()).not.toContain("3/3 ·");
    expect(ui()).not.toMatch(/TODO {2}3\/3/);

    // The model re-writes the same finished list; that is not a second finish.
    bus.emit({ type: "todo_changed", items: done(3) });
    await tick(80);
    expect(ui().split("todo list complete").length - 1).toBe(1);

    // A NEW list re-opens the strip — clearing is a display rule, not a latch.
    bus.emit({ type: "todo_changed", items: items(4, 0) });
    await waitFor(ui, (f) => f.includes("0/4"));
    unmount();
  });
});
