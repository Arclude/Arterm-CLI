import { EventBus, defaultConfig } from "@arterm/core";
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

/** A session whose agent takes a while per turn, emitting the real event flow. */
function fakeSession(bus: EventBus): Session {
  const noop = (): void => {};
  return {
    agent: {
      model: "qwen2.5:7b",
      effectiveContextWindow: () => 8192,
      reset: () => {},
      run: async (text: string) => {
        bus.emit({ type: "turn_start" });
        await tick(150);
        bus.emit({
          type: "assistant_message",
          message: { role: "assistant", content: `echo:${text}` },
        });
        bus.emit({ type: "turn_end" });
      },
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

describe("prompt queue (typing stays live while a turn runs)", () => {
  it("queues prompts submitted mid-turn and dispatches them FIFO", async () => {
    const bus = new EventBus();
    const { stdin, frames, unmount } = render(createElement(App, { session: fakeSession(bus) }));
    const seen = () => frames.join("\n");
    await tick();

    // First prompt starts a turn.
    stdin.write("one");
    await tick();
    stdin.write(ENTER);
    await waitFor(seen, (f) => f.includes("working…"));

    // The prompt is still live: type and submit two more while the turn runs.
    stdin.write("two");
    await tick();
    stdin.write(ENTER);
    await waitFor(seen, (f) => f.includes("⏳ two"));
    stdin.write("three");
    await tick();
    stdin.write(ENTER);
    await waitFor(seen, (f) => f.includes("⏳ three"));

    // All three answers arrive, in submission order.
    await waitFor(
      seen,
      (f) => f.includes("echo:one") && f.includes("echo:two") && f.includes("echo:three"),
    );
    const out = seen();
    expect(out.indexOf("echo:one")).toBeLessThan(out.indexOf("echo:two"));
    expect(out.indexOf("echo:two")).toBeLessThan(out.indexOf("echo:three"));

    unmount();
  });
});
