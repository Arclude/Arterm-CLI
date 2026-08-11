import { EventBus, defaultConfig } from "@arterm/core";
import { render } from "ink-testing-library";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { App } from "./App.js";
import type { Session } from "./types.js";

/**
 * Direct drag-to-select (like jcode): no key to enter a mode, just press-drag-
 * release over the transcript. The projection and the coordinate math are unit
 * tested in selection.test.ts; this proves the wiring — the overlay shows on a
 * drag, and the release copies it to the clipboard.
 *
 * The clipboard write goes through the real `copyToClipboard`, which on a
 * non-TTY test process falls to OSC 52 written to `rawStdout`. We do not assert
 * the OS clipboard (there is none in CI); we assert the app's own report, which
 * is what a user sees.
 */

const ESC = String.fromCharCode(27);
const tick = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** SGR mouse byte helpers (1-based wire coordinates). */
const down = (col: number, row: number): string => `${ESC}[<0;${col};${row}M`;
const drag = (col: number, row: number): string => `${ESC}[<32;${col};${row}M`;
const up = (col: number, row: number): string => `${ESC}[<0;${col};${row}m`;

async function waitFor(
  frame: () => string | undefined,
  pred: (f: string) => boolean,
  timeout = 2500,
): Promise<void> {
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
      interject: () => {},
      takeInterjections: () => [],
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

describe("drag-to-select", () => {
  it("a mouse drag over the transcript selects, release copies", async () => {
    const bus = new EventBus();
    const { stdin, lastFrame, frames, unmount } = render(
      createElement(App, { session: fakeSession(bus), fullscreen: true }),
    );
    const ui = () => lastFrame() ?? "";
    const seen = () => frames.join("\n");
    await tick();

    // Overflow the viewport so every visible row carries text.
    for (let i = 0; i < 60; i++) {
      bus.emit({
        type: "assistant_message",
        message: { role: "assistant", content: `selectable line number ${i}` },
      });
    }
    await tick(200);

    // Direct drag: no key needed. Press, drag, release over a filled row.
    stdin.write(down(1, 2));
    stdin.write(drag(24, 2));
    stdin.write(up(24, 2));

    await waitFor(seen, (f) => /⧉ copied \d+ chars to the clipboard/.test(f), 3000);
    expect(seen()).toMatch(/⧉ copied \d+ chars/);

    // Prove the CONTENT reached the clipboard. On a non-TTY test process
    // copyToClipboard falls to OSC 52, whose payload is the selected text
    // base64-encoded in an ESC]52;c;<b64> sequence written to stdout.
    const osc = seen().match(/\]52;c;([A-Za-z0-9+/=]+)/);
    expect(osc, "an OSC 52 clipboard write was emitted").not.toBeNull();
    const copied = Buffer.from(osc?.[1] ?? "", "base64").toString("utf8");
    expect(copied.length).toBeGreaterThan(0);
    expect(copied).toMatch(/selectable line number/);

    // After the copy, the overlay is gone and the transcript is back.
    await waitFor(ui, (f) => !f.includes("selecting"), 3000);

    unmount();
  });

  it("a plain click (no drag) does not select or copy", async () => {
    const bus = new EventBus();
    const { stdin, frames, unmount } = render(
      createElement(App, { session: fakeSession(bus), fullscreen: true }),
    );
    const seen = () => frames.join("\n");
    await tick();

    // A quick press+release with no drag event — should not trigger a copy.
    stdin.write(down(1, 2));
    stdin.write(up(1, 2));
    await tick(300);

    expect(seen()).not.toMatch(/⧉ copied/);
    unmount();
  });
});
