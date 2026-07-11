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

describe("static transcript (native scrollback — no alt screen, no mouse capture)", () => {
  it("commits messages to static output and never captures the mouse or alt screen", async () => {
    const bus = new EventBus();
    const { frames, unmount } = render(createElement(App, { session: fakeSession(bus) }));
    const seen = () => frames.join("\n");
    await tick();

    for (let i = 0; i < 30; i++) {
      bus.emit({
        type: "assistant_message",
        message: { role: "assistant", content: `line number ${i}` },
      });
    }
    // Everything lands in the terminal's (captured) output stream — this is what
    // ends up in native scrollback. (Ink runs in debug mode under the testing
    // library — every frame carries the full static prefix — so static/dynamic
    // separation itself is not observable here.)
    await waitFor(seen, (f) => f.includes("line number 0") && f.includes("line number 29"));

    // Native selection/scrollback must never be broken: no alternate screen, no
    // SGR mouse capture, anywhere in the emitted bytes.
    expect(seen()).not.toContain("[?1049h");
    expect(seen()).not.toContain("[?1000h");
    expect(seen()).not.toContain("[?1006h");

    unmount();
  });

  it("streams the live message in the dynamic region, then commits it above", async () => {
    const bus = new EventBus();
    const { frames, unmount } = render(createElement(App, { session: fakeSession(bus) }));
    const seen = () => frames.join("\n");
    await tick();

    bus.emit({ type: "turn_start" });
    for (const word of ["stream", "ing ", "words"]) {
      bus.emit({ type: "text_delta", delta: word });
    }
    // Deltas are buffered and flushed on the ~45ms throttle — the phrase arrives
    // in the live preview as one repaint, not one per token.
    await waitFor(seen, (f) => f.includes("streaming words"));

    bus.emit({
      type: "assistant_message",
      message: { role: "assistant", content: "streaming words final" },
    });
    bus.emit({ type: "turn_end" });
    // The committed message is appended to the static transcript.
    await waitFor(seen, (f) => f.includes("streaming words final"));

    unmount();
  });

  it("a lone ↑ recalls prompt history", async () => {
    const bus = new EventBus();
    const { stdin, lastFrame, unmount } = render(createElement(App, { session: fakeSession(bus) }));
    await tick();

    stdin.write("hello history");
    await tick();
    stdin.write("\r");
    await tick();

    stdin.write(`${String.fromCharCode(27)}[A`);
    await waitFor(
      () => lastFrame() ?? "",
      (f) => f.includes("› hello history"),
    );

    unmount();
  });
});
