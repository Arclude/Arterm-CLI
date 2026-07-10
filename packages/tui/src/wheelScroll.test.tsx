import { EventBus, defaultConfig } from "@arterm/core";
import { render } from "ink-testing-library";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { App } from "./App.js";
import type { Session } from "./types.js";

const tick = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor(
  frame: () => string | undefined,
  pred: (f: string) => boolean,
  timeout = 2500,
) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (pred(frame() ?? "")) return;
    await tick(20);
  }
  throw new Error(`condition not met within ${timeout}ms; last frame:\n${frame()}`);
}

/** SGR mouse report for one wheel notch (64 = up, 65 = down). */
const WHEEL_UP = "[<64;10;10M";
const WHEEL_DOWN = "[<65;10;10M";

function fakeSession(bus: EventBus): Session {
  const noop = (): void => {};
  return {
    agent: {
      model: "qwen2.5:7b",
      effectiveContextWindow: () => 8192,
      reset: () => {},
      run: async () => {},
    },
    bus,
    config: { ...defaultConfig() },
    providerLabel: "ollama",
    toolCount: 7,
    yolo: false,
    setAsker: noop,
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
    permissionMode: "auto",
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

describe("transcript wheel scrolling", () => {
  it("wheel up reveals older lines; wheel down returns to the bottom", async () => {
    const bus = new EventBus();
    const { stdin, lastFrame, unmount } = render(createElement(App, { session: fakeSession(bus) }));
    await tick();

    // Overflow the viewport so there is something to scroll back to.
    for (let i = 0; i < 60; i++) {
      bus.emit({
        type: "assistant_message",
        message: { role: "assistant", content: `line number ${i}` },
      });
    }
    await tick();

    // Pinned to the bottom: no scroll hint.
    expect(lastFrame() ?? "").not.toContain("satır yukarıda");

    // Wheel UP (a couple of notches) lifts the view — the offset hint appears.
    stdin.write(WHEEL_UP);
    stdin.write(WHEEL_UP);
    await waitFor(lastFrame, (f) => f.includes("satır yukarıda"));

    // Wheel DOWN returns toward the newest output until the hint disappears.
    stdin.write(WHEEL_DOWN);
    stdin.write(WHEEL_DOWN);
    await waitFor(lastFrame, (f) => !f.includes("satır yukarıda"));

    unmount();
  });
});
