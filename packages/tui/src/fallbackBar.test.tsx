import { EventBus, PermissionBroker, defaultConfig } from "@arterm/core";
import { render } from "ink-testing-library";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { App } from "./App.js";
import type { Session } from "./types.js";

const ENTER = "\r";
const tick = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor(view: () => string, pred: (f: string) => boolean, timeout = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (pred(view())) return;
    await tick(20);
  }
  throw new Error(`condition not met within ${timeout}ms; last view:\n${view()}`);
}

function fakeSession(bus: EventBus, over: Partial<Session> = {}): Session {
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
    ...over,
  } as unknown as Session;
}

/**
 * After the chain switches models, the `↪` transcript line scrolls away and the
 * footer used to keep naming the model the user *chose* — so nothing on screen
 * said the replies were coming from somewhere else.
 */
describe("status bar during a provider fallback", () => {
  it("names both the configured model and the one actually answering", async () => {
    const bus = new EventBus();
    const { frames, unmount } = render(createElement(App, { session: fakeSession(bus) }));
    const ui = () => [...frames].reverse().find((f) => f.includes("ARTERM")) ?? "";
    await tick();

    expect(ui()).toContain("openai-compat/fake");
    expect(ui()).not.toContain("↪backup");

    bus.emit({
      type: "provider_fallback",
      from: { provider: "openai-compat", model: "fake" },
      to: { provider: "openai-compat", model: "backup" },
      reason: "quota",
      detail: "HTTP 429",
    });

    await waitFor(ui, (f) => f.includes("fake↪backup"));
    unmount();
  });

  it("qualifies a cross-provider landing with the provider id", async () => {
    const bus = new EventBus();
    const { frames, unmount } = render(createElement(App, { session: fakeSession(bus) }));
    const ui = () => [...frames].reverse().find((f) => f.includes("ARTERM")) ?? "";
    await tick();

    bus.emit({
      type: "provider_fallback",
      from: { provider: "openai-compat", model: "fake" },
      to: { provider: "ollama", model: "qwen3" },
      reason: "overloaded",
      detail: "HTTP 503",
    });

    await waitFor(ui, (f) => f.includes("fake↪ollama/qwen3"));
    unmount();
  });

  it("clears the marker when the user picks a model explicitly", async () => {
    const bus = new EventBus();
    const session = fakeSession(bus);
    const { stdin, frames, unmount } = render(createElement(App, { session }));
    const ui = () => [...frames].reverse().find((f) => f.includes("ARTERM")) ?? "";
    await tick();

    bus.emit({
      type: "provider_fallback",
      from: { provider: "openai-compat", model: "fake" },
      to: { provider: "openai-compat", model: "backup" },
      reason: "quota",
      detail: "HTTP 429",
    });
    await waitFor(ui, (f) => f.includes("fake↪backup"));

    // An explicit switch rebuilds the chain, so the old landing spot is stale.
    stdin.write("/model other");
    await tick();
    stdin.write(ENTER);
    await waitFor(ui, (f) => !f.includes("↪backup"));
    unmount();
  });
});

/**
 * `/permissions` renders the table the CLI injects. The TUI must not build its
 * own — a second implementation is exactly how an inspector starts describing a
 * policy nobody runs.
 */
describe("/permissions", () => {
  it("renders the injected table", async () => {
    const bus = new EventBus();
    const session = fakeSession(bus, {
      permissionsTable: () => "mode: yolo   2 tools\n\n  ✓ runs*  bash  execute ask",
    });
    const { stdin, frames, unmount } = render(createElement(App, { session }));
    const ui = () => [...frames].reverse().find((f) => f.includes("ARTERM")) ?? "";
    await tick();

    stdin.write("/permissions");
    await tick();
    stdin.write(ENTER);
    await waitFor(ui, (f) => f.includes("mode: yolo") && f.includes("✓ runs*"));
    unmount();
  });

  it("passes mode and outcome through in either order", async () => {
    const bus = new EventBus();
    const seen: Array<{ mode?: string; only?: string }> = [];
    const session = fakeSession(bus, {
      permissionsTable: (opts = {}) => {
        seen.push(opts);
        return "table rendered";
      },
    });
    const { stdin, frames, unmount } = render(createElement(App, { session }));
    const ui = () => [...frames].reverse().find((f) => f.includes("ARTERM")) ?? "";
    await tick();

    stdin.write("/permissions deny plan");
    await tick();
    stdin.write(ENTER);
    await waitFor(ui, (f) => f.includes("table rendered"));
    expect(seen[0]).toEqual({ mode: "plan", only: "deny" });
    unmount();
  });

  it("rejects an argument that is neither a mode nor an outcome", async () => {
    const bus = new EventBus();
    let called = false;
    const session = fakeSession(bus, {
      permissionsTable: () => {
        called = true;
        return "table";
      },
    });
    const { stdin, frames, unmount } = render(createElement(App, { session }));
    const ui = () => [...frames].reverse().find((f) => f.includes("ARTERM")) ?? "";
    await tick();

    stdin.write("/permissions banana");
    await tick();
    stdin.write(ENTER);
    await waitFor(ui, (f) => f.includes('unknown argument "banana"'));
    expect(called).toBe(false);
    unmount();
  });

  it("says so when the session has no table injected", async () => {
    const bus = new EventBus();
    const { stdin, frames, unmount } = render(createElement(App, { session: fakeSession(bus) }));
    const ui = () => [...frames].reverse().find((f) => f.includes("ARTERM")) ?? "";
    await tick();

    stdin.write("/permissions");
    await tick();
    stdin.write(ENTER);
    await waitFor(ui, (f) => f.includes("permissions table unavailable"));
    unmount();
  });
});
