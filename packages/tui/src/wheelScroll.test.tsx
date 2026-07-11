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

function overflowTranscript(bus: EventBus): void {
  for (let i = 0; i < 60; i++) {
    bus.emit({
      type: "assistant_message",
      message: { role: "assistant", content: `line number ${i}` },
    });
  }
}

describe("transcript wheel scrolling (alternate scroll, no mouse capture)", () => {
  it("wheel up reveals older lines; wheel down returns to the bottom", async () => {
    const bus = new EventBus();
    const { stdin, lastFrame, unmount } = render(createElement(App, { session: fakeSession(bus) }));
    await tick();
    overflowTranscript(bus);
    await tick();

    // Pinned to the bottom: no scroll hint.
    expect(lastFrame() ?? "").not.toContain("satır yukarıda");

    // Wheel UP (a couple of ticks, each a batched arrow chunk) lifts the view.
    stdin.write(WHEEL_UP);
    stdin.write(WHEEL_UP);
    await waitFor(lastFrame, (f) => f.includes("satır yukarıda"));

    // Wheel DOWN returns toward the newest output until the hint disappears.
    stdin.write(WHEEL_DOWN);
    stdin.write(WHEEL_DOWN);
    await waitFor(lastFrame, (f) => !f.includes("satır yukarıda"));

    unmount();
  });

  it("PgUp/PgDn page the transcript", async () => {
    const bus = new EventBus();
    const { stdin, lastFrame, unmount } = render(createElement(App, { session: fakeSession(bus) }));
    await tick();
    overflowTranscript(bus);
    await tick();

    stdin.write(`${ESC}[5~`); // PgUp
    await waitFor(lastFrame, (f) => f.includes("satır yukarıda"));
    stdin.write(`${ESC}[6~`); // PgDn
    await waitFor(lastFrame, (f) => !f.includes("satır yukarıda"));

    unmount();
  });

  it("a lone ↑ recalls prompt history instead of scrolling", async () => {
    const bus = new EventBus();
    const { stdin, lastFrame, unmount } = render(createElement(App, { session: fakeSession(bus) }));
    await tick();

    stdin.write("hello history");
    await tick();
    stdin.write("\r");
    await waitFor(lastFrame, (f) => f.includes("hello history"));

    // A single arrow (one keypress) must pass the hold-back window and land in
    // the prompt as history — and must NOT lift the transcript.
    overflowTranscript(bus);
    await tick();
    stdin.write(`${ESC}[A`);
    await waitFor(lastFrame, (f) => f.includes("› hello history"));
    expect(lastFrame() ?? "").not.toContain("satır yukarıda");

    unmount();
  });
});
