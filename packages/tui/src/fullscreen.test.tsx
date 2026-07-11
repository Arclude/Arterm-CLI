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
/** SGR mouse wheel reports (captured mode; 64 = up, 65 = down). */
const SGR_UP = "[<64;10;10M";
const SGR_DOWN = "[<65;10;10M";
/** One wheel tick under alternate scroll (uncaptured fallback): arrow chunk. */
const WHEEL_UP = `${ESC}[A`.repeat(3);
const WHEEL_DOWN = `${ESC}[B`.repeat(3);

function fakeSession(bus: EventBus, tui?: { fullscreen?: boolean; mouse?: boolean }): Session {
  const noop = (): void => {};
  return {
    agent: {
      model: "qwen2.5:7b",
      effectiveContextWindow: () => 8192,
      reset: () => {},
      run: async () => {},
    },
    bus,
    config: { ...defaultConfig(), ...(tui ? { tui } : {}) },
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
  it("captured mouse (default): SGR wheel scrolls in-app, footer pinned in every frame", async () => {
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

    // Pinned to the newest output; the footer (status bar) is in the frame,
    // and the hint advertises the capture-mode selection bypass.
    expect(ui()).toContain("ARTERM");
    expect(ui()).toContain("shift+drag selects");
    expect(ui()).not.toContain("satır yukarıda");

    // Pinned view shows the NEWEST line.
    expect(ui()).toContain("line number 59");

    // Wheel UP (SGR reports — direction is IN the bytes) reveals OLDER lines:
    // the newest line leaves the window, an older one enters, and the footer
    // is STILL in the very same frame (pinned, not scrolled away).
    stdin.write(SGR_UP);
    stdin.write(SGR_UP);
    await waitFor(ui, (f) => f.includes("satır yukarıda"));
    expect(ui()).not.toContain("line number 59");
    expect(ui()).toContain("line number 53");
    expect(ui()).toContain("ARTERM");
    expect(ui()).toContain("› "); // the input line is visible while scrolled

    // Wheel DOWN returns toward the newest output until the hint disappears.
    stdin.write(SGR_DOWN);
    stdin.write(SGR_DOWN);
    await waitFor(ui, (f) => !f.includes("satır yukarıda"));
    expect(ui()).toContain("line number 59");

    unmount();
  });

  it("uncaptured fallback (tui.mouse=false): alternate-scroll arrows drive the scroll", async () => {
    const bus = new EventBus();
    const { stdin, frames, unmount } = render(
      createElement(App, {
        session: fakeSession(bus, { fullscreen: true, mouse: false }),
        fullscreen: true,
      }),
    );
    const ui = () => [...frames].reverse().find((f) => f.includes("ARTERM")) ?? "";
    await tick();

    for (let i = 0; i < 60; i++) {
      bus.emit({
        type: "assistant_message",
        message: { role: "assistant", content: `line number ${i}` },
      });
    }
    await tick();
    expect(ui()).toContain("drag selects text"); // no capture — native selection

    stdin.write(WHEEL_UP);
    stdin.write(WHEEL_UP);
    await waitFor(ui, (f) => f.includes("satır yukarıda"));

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
