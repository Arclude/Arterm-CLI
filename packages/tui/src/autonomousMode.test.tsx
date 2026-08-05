import { EventBus, PermissionBroker, defaultConfig } from "@arterm/core";
import { render } from "ink-testing-library";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { App } from "./App.js";
import type { Session } from "./types.js";

const ENTER = "\r";
const SHIFT_TAB = "[Z";
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
 * Shift+Tab's fourth slot. The TUI owns only the gesture and the badge — the
 * profile itself lives behind `session.setAutonomous` — so what these tests
 * pin is the wiring: the cycle reaches the slot, the badge appears, a plain
 * prompt becomes `autonomy.start(goal)`, and one more Shift+Tab leaves.
 */
describe("Shift+Tab AUTONOMOUS slot", () => {
  it("arms after PLAN, prints the announcement, and routes a prompt to autonomy.start", async () => {
    const bus = new EventBus();
    const toggles: boolean[] = [];
    const goals: string[] = [];
    const session = fakeSession(bus, {
      setAutonomous: (on: boolean) => {
        toggles.push(on);
        return on ? ["◆ AUTONOMOUS armed (test)"] : ["◆ autonomous disarmed (test)"];
      },
      autonomy: {
        state: "idle",
        start: async (g: string) => {
          goals.push(g);
        },
        pause: () => {},
        resume: () => {},
        stop: () => {},
        steer: () => {},
        setMode: () => true,
      },
    } as unknown as Partial<Session>);
    const { frames, stdin, unmount } = render(createElement(App, { session }));
    const ui = () => [...frames].reverse().find((f) => f.includes("ARTERM")) ?? "";
    await tick();

    // ask → auto → plan → AUTONOMOUS
    stdin.write(SHIFT_TAB);
    await waitFor(ui, (f) => f.includes("AUTO"));
    stdin.write(SHIFT_TAB);
    await waitFor(ui, (f) => f.includes("PLAN"));
    stdin.write(SHIFT_TAB);
    await waitFor(ui, (f) => f.includes("AUTONOMOUS"));
    expect(toggles).toEqual([true]);
    expect(ui()).toContain("AUTONOMOUS armed (test)");

    // A plain prompt is now the goal, not a chat turn.
    stdin.write("harden the retry loop");
    await tick();
    stdin.write(ENTER);
    await waitFor(ui, () => goals.length === 1);
    expect(goals).toEqual(["harden the retry loop"]);

    // One more Shift+Tab disarms back to ASK.
    stdin.write(SHIFT_TAB);
    await waitFor(ui, (f) => f.includes("disarmed (test)"));
    expect(toggles).toEqual([true, false]);
    unmount();
  });

  it("keeps the plain three-mode cycle when the session cannot arm", async () => {
    const bus = new EventBus();
    // No setAutonomous (headless/test session): plan wraps to ask, as before.
    const session = fakeSession(bus);
    const { frames, stdin, unmount } = render(createElement(App, { session }));
    const ui = () => [...frames].reverse().find((f) => f.includes("ARTERM")) ?? "";
    await tick();

    stdin.write(SHIFT_TAB);
    await waitFor(ui, (f) => f.includes("permission mode → AUTO"));
    stdin.write(SHIFT_TAB);
    await waitFor(ui, (f) => f.includes("permission mode → PLAN"));
    stdin.write(SHIFT_TAB);
    await waitFor(ui, (f) => f.includes("permission mode → ASK"));
    expect(ui()).not.toContain("AUTONOMOUS");
    unmount();
  });
});
