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
/**
 * One wheel tick as a CAPTURED mouse sends it: an SGR report whose button byte
 * carries the direction (64 = up, 65 = down). The point of the whole mechanism
 * is that no keypress can spell this, so it can never be read as history ↑.
 */
const WHEEL_UP = `${ESC}[<64;10;10M`;
const WHEEL_DOWN = `${ESC}[<65;10;10M`;
const PAGE_UP = `${ESC}[5~`;
const PAGE_DOWN = `${ESC}[6~`;

function fakeSession(bus: EventBus, tui?: { fullscreen?: boolean }): Session {
  const noop = (): void => {};
  return {
    agent: {
      model: "qwen2.5:7b",
      effectiveContextWindow: () => 8192,
      interject: () => {},
      takeInterjections: () => [],
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
  it("PgUp/PgDn scroll the transcript, footer pinned in every frame", async () => {
    const bus = new EventBus();
    const { stdin, frames, unmount } = render(
      createElement(App, {
        session: fakeSession(bus, { fullscreen: true }),
        fullscreen: true,
      }),
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
    // Long enough for the transcript to MEASURE itself: the scroll offset is
    // clamped to the measured content, so a key pressed before the first
    // measurement lands is clamped to zero and silently does nothing.
    await tick(200);

    // Pinned to the newest output; the footer (status bar) is in the frame, and
    // the hint names the keys that actually scroll HERE — the wheel has no
    // scrollback to move on the alternate screen, so advertising it would be a
    // working build reading as a broken one.
    expect(ui()).toContain("ARTERM");
    // (The rest of the hint line — "· drag selects text" — is past the width
    // this harness renders at, so it is asserted in statusChips.test.tsx.)
    expect(ui()).toContain("wheel scrolls");
    expect(ui()).not.toContain("satır yukarıda");
    expect(ui()).toContain("line number 59");

    // PgUp reveals OLDER lines: the newest leaves the window, an older one
    // enters, and the footer is STILL in the very same frame (pinned).
    stdin.write(PAGE_UP);
    await waitFor(ui, (f) => f.includes("satır yukarıda"));
    expect(ui()).not.toContain("line number 59");
    expect(ui()).toContain("ARTERM");
    expect(ui()).toContain("› "); // the input line is visible while scrolled

    stdin.write(PAGE_DOWN);
    await waitFor(ui, (f) => !f.includes("satır yukarıda"));
    expect(ui()).toContain("line number 59");

    unmount();
  });

  it("a wheel tick scrolls the chat and never touches history", async () => {
    // Both halves of the reported bug, in one test, against the channel that
    // replaced the broken one. The tick has to MOVE the transcript — a wheel
    // that does nothing is the complaint this started from — and it must not
    // walk the prompt back through history, which is what "I scrolled and my
    // old prompt appeared" was. With SGR reporting the second half is
    // structural rather than heuristic: `ESC[<64;…M` is not `ESC[A`.
    const bus = new EventBus();
    const { stdin, frames, unmount } = render(
      createElement(App, {
        session: fakeSession(bus, { fullscreen: true }),
        fullscreen: true,
      }),
    );
    const ui = () => [...frames].reverse().find((f) => f.includes("ARTERM")) ?? "";
    await tick();

    stdin.write("an old prompt");
    await tick();
    stdin.write("\r");
    await tick();

    for (let i = 0; i < 60; i++) {
      bus.emit({
        type: "assistant_message",
        message: { role: "assistant", content: `line number ${i}` },
      });
    }
    // The offset is clamped to the MEASURED content, so a tick arriving before
    // the first measurement lands is clamped to zero and silently does nothing.
    await tick(200);

    stdin.write(WHEEL_UP);
    stdin.write(WHEEL_UP);
    await waitFor(ui, (f) => f.includes("satır yukarıda")); // it scrolled
    expect(ui()).not.toContain("› an old prompt"); // and history is untouched
    expect(ui()).not.toContain("line number 59");

    // Back down returns to the newest output, and still never to the prompt.
    for (let i = 0; i < 4; i++) stdin.write(WHEEL_DOWN);
    await waitFor(ui, (f) => !f.includes("satır yukarıda"));
    expect(ui()).toContain("line number 59");
    expect(ui()).not.toContain("› an old prompt");

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
