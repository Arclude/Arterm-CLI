import { EventBus, defaultConfig } from "@arterm/core";
import { render } from "ink-testing-library";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { App } from "./App.js";
import type { Session } from "./types.js";

const tick = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor(view: () => string, pred: (f: string) => boolean, timeout = 2500) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (pred(view())) return;
    await tick(20);
  }
  throw new Error(`condition not met within ${timeout}ms; last view:\n${view()}`);
}

const ESC = String.fromCharCode(27);
/** One wheel tick under alternate scroll (DECSET 1007): a batched arrow chunk. */
const WHEEL_UP = `${ESC}[A`.repeat(3);
const WHEEL_DOWN = `${ESC}[B`.repeat(3);

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

describe("fullscreen mode (alt buffer: pinned footer + in-app scroll)", () => {
  it("keeps the footer in every frame and scrolls the chat in-app with the wheel", async () => {
    const bus = new EventBus();
    const { stdin, frames, unmount } = render(
      createElement(App, { session: fakeSession(bus), fullscreen: true }),
    );
    const ui = () => [...frames].reverse().find((f) => f.includes("ARTERM")) ?? "";
    await tick();

    // Overflow the viewport so there is something to scroll back to.
    for (let i = 0; i < 60; i++) {
      bus.emit({
        type: "assistant_message",
        message: { role: "assistant", content: `line number ${i}` },
      });
    }
    await tick();

    // Pinned to the newest output; the footer (status bar) is in the frame.
    expect(ui()).toContain("ARTERM");
    expect(ui()).not.toContain("satır yukarıda");

    // Wheel UP (batched arrow chunks) lifts the view — the offset hint appears,
    // and the footer is STILL in the very same frame (pinned, not scrolled away).
    stdin.write(WHEEL_UP);
    stdin.write(WHEEL_UP);
    await waitFor(ui, (f) => f.includes("satır yukarıda"));
    expect(ui()).toContain("ARTERM");
    expect(ui()).toContain("› "); // the input line is visible while scrolled

    // Wheel DOWN returns toward the newest output until the hint disappears.
    stdin.write(WHEEL_DOWN);
    stdin.write(WHEEL_DOWN);
    await waitFor(ui, (f) => !f.includes("satır yukarıda"));

    unmount();
  });

  it("a lone ↑ still recalls prompt history in fullscreen", async () => {
    const bus = new EventBus();
    const { stdin, frames, unmount } = render(
      createElement(App, { session: fakeSession(bus), fullscreen: true }),
    );
    const ui = () => [...frames].reverse().find((f) => f.includes("ARTERM")) ?? "";
    await tick();

    stdin.write("hello fullscreen");
    await tick();
    stdin.write("\r");
    await tick();

    stdin.write(`${ESC}[A`);
    await waitFor(ui, (f) => f.includes("› hello fullscreen"));

    unmount();
  });
});
