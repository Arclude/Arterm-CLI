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

describe("/copy", () => {
  it("copies the last assistant reply via OSC 52", async () => {
    const bus = new EventBus();
    const { stdin, frames, unmount } = render(createElement(App, { session: fakeSession(bus) }));
    // System replies are committed to <Static> (native scrollback), so they show
    // up in the accumulated output stream rather than the last dynamic frame.
    const seen = () => frames.join("\n");
    await tick();

    // Nothing to copy yet.
    stdin.write("/copy");
    await tick();
    stdin.write(ENTER);
    await waitFor(seen, (f) => f.includes("nothing to copy"));

    bus.emit({
      type: "assistant_message",
      message: { role: "assistant", content: "copy me please" },
    });
    await tick();

    stdin.write("/copy");
    await tick();
    stdin.write(ENTER);
    await waitFor(seen, (f) => f.includes("⧉ copied the last reply"));
    expect(seen()).toContain("14 chars");

    unmount();
  });

  it("/copy all puts the whole conversation on the clipboard, OSC 52 payload included", async () => {
    const bus = new EventBus();
    const { stdin, frames, unmount } = render(createElement(App, { session: fakeSession(bus) }));
    const seen = () => frames.join("\n");
    await tick();

    // A real submit: user items exist only through the input path (there is no
    // user_message bus event — the transcript is the source of truth here).
    stdin.write("soru bir");
    await tick();
    stdin.write(ENTER);
    await tick();
    bus.emit({
      type: "assistant_message",
      message: { role: "assistant", content: "cevap bir" },
    });
    await tick();

    stdin.write("/copy all");
    await tick();
    stdin.write(ENTER);
    await waitFor(seen, (f) => f.includes("⧉ copied the conversation"));
    // The OSC 52 write itself must carry the conversation: user line prefixed
    // with ›, messages joined by a blank line, base64 in the escape payload.
    const b64 = Buffer.from("› soru bir\n\ncevap bir", "utf8").toString("base64");
    expect(frames.join("")).toContain(`52;c;${b64}`);

    unmount();
  });
});
