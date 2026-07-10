import { EventBus, defaultConfig } from "@arterm/core";
import { render } from "ink-testing-library";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { App } from "./App.js";
import type { Session } from "./types.js";

const ENTER = "\r";
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

describe("/copy and /mouse", () => {
  it("copies the last assistant reply via OSC 52 and toggles mouse capture", async () => {
    const bus = new EventBus();
    const { stdin, lastFrame, unmount } = render(createElement(App, { session: fakeSession(bus) }));
    await tick();

    // Nothing to copy yet.
    stdin.write("/copy");
    await tick();
    stdin.write(ENTER);
    await waitFor(lastFrame, (f) => f.includes("nothing to copy"));

    bus.emit({
      type: "assistant_message",
      message: { role: "assistant", content: "copy me please" },
    });
    await tick();

    stdin.write("/copy");
    await tick();
    stdin.write(ENTER);
    await waitFor(lastFrame, (f) => f.includes("⧉ copied the last reply"));
    expect(lastFrame() ?? "").toContain("14 chars");

    // Mouse capture toggles off and back on with clear state lines.
    stdin.write("/mouse");
    await tick();
    stdin.write(ENTER);
    await waitFor(lastFrame, (f) => f.includes("mouse capture OFF"));
    stdin.write("/mouse");
    await tick();
    stdin.write(ENTER);
    await waitFor(lastFrame, (f) => f.includes("mouse capture ON"));

    unmount();
  });
});
