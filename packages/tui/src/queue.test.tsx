import { EventBus, defaultConfig } from "@arterm/core";
import { render } from "ink-testing-library";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { App } from "./App.js";
import type { Session } from "./types.js";

const ENTER = "\r";
const tick = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms));

// 20s, not 4: this polls, so the bound is only a FAILURE deadline and costs
// nothing when the condition holds early. Six vitest workers running in
// parallel — some of them spawning language servers and parsing with
// tree-sitter — can push a render past four seconds on a loaded machine, and a
// bound tight enough to trip on load is a test that reports the machine rather
// than the code.
async function waitFor(view: () => string, pred: (f: string) => boolean, timeout = 20_000) {
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
      interject: () => {},
      takeInterjections: () => [],
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
    const latest = () => frames[frames.length - 1] ?? "";

    /**
     * Type a prompt and submit it, waiting for the CHARACTERS to land first.
     *
     * A fixed `tick()` here is what made this test fail under parallel load,
     * roughly two runs in three: Ink had not finished mounting and subscribing
     * to stdin, so the keystrokes went nowhere. The symptom was a 20-second
     * timeout pointing at an empty composer and an idle status bar — which
     * reads like the queue is broken, when nothing was ever typed.
     */
    const submit = async (text: string): Promise<void> => {
      stdin.write(text);
      await waitFor(latest, (f) => f.includes(text));
      stdin.write(ENTER);
    };

    // Wait for the composer to exist before typing at it at all.
    await waitFor(latest, (f) => f.includes("message…"));

    // First prompt starts a turn. The working line carries a spinner and a
    // running clock, so match the word and the elapsed time.
    await submit("one");
    await waitFor(seen, (f) => /working \d/.test(f));

    // The prompt is still live: type and submit two more while the turn runs.
    await submit("two");
    await waitFor(seen, (f) => f.includes("⏳ two"));
    await submit("three");
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
  }, 30_000);

  it("a landed interjection leaves the queue instead of being sent twice", async () => {
    // The queue stays the source of truth while a turn runs, so the two paths
    // have to agree: when the agent folds a prompt into the RUNNING turn, the
    // queued copy must go, or the same words are dispatched again at turn end.
    const bus = new EventBus();
    const { stdin, frames, unmount } = render(createElement(App, { session: fakeSession(bus) }));
    const seen = () => frames.join("\n");
    const latest = () => frames[frames.length - 1] ?? "";

    await waitFor(latest, (f) => f.includes("message…"));
    stdin.write("one");
    await waitFor(latest, (f) => f.includes("one"));
    stdin.write(ENTER);
    await waitFor(seen, (f) => /working \d/.test(f));

    stdin.write("two");
    await waitFor(latest, (f) => f.includes("two"));
    stdin.write(ENTER);
    await waitFor(seen, (f) => f.includes("\u23f3 two"));

    // The agent reports that it reached the model mid-turn.
    bus.emit({ type: "interjected", text: "two" });
    await waitFor(latest, (f) => !f.includes("\u23f3 two"));
    expect(seen()).toContain("iletildi");

    unmount();
  }, 30_000);
});
