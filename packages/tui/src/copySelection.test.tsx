import { EventBus, defaultConfig } from "@arterm/core";
import { render } from "ink-testing-library";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { App } from "./App.js";
import type { Session } from "./types.js";

/**
 * The jcode-style copy-selection mode, driven end to end through the real App:
 * Ctrl+E enters, a mouse press-drag-release over the transcript selects text,
 * and the release copies it. The projection and the coordinate math are unit
 * tested in selection.test.ts; this proves the wiring — the mode toggles, the
 * overlay renders, and a drag reaches the clipboard call.
 *
 * The clipboard write goes through the real `copyToClipboard`, which on a
 * non-TTY test process falls to OSC 52 written to `rawStdout`. We do not assert
 * the OS clipboard (there is none in CI); we assert the app's own report, which
 * is what a user sees.
 */

const ESC = String.fromCharCode(27);
const CTRL_E = "\u0005";
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

describe("copy-selection mode", () => {
  it("Ctrl+E in classic mode explains that the terminal owns selection", async () => {
    const bus = new EventBus();
    const { stdin, frames, unmount } = render(createElement(App, { session: fakeSession(bus) }));
    const seen = () => frames.join("\n");
    await tick();

    stdin.write(CTRL_E);
    await waitFor(seen, (f) => f.includes("drag already selects text"));

    unmount();
  });

  it("Ctrl+E in fullscreen enters SELECT, a drag copies, and it reports the copy", async () => {
    const bus = new EventBus();
    const { stdin, lastFrame, frames, unmount } = render(
      createElement(App, { session: fakeSession(bus), fullscreen: true }),
    );
    const ui = () => lastFrame() ?? "";
    const seen = () => frames.join("\n");
    await tick();

    // Overflow the viewport so every visible row carries text — the projection
    // is bottom-anchored, so a short transcript leaves the top rows blank and a
    // drag there would (correctly) select nothing.
    for (let i = 0; i < 60; i++) {
      bus.emit({
        type: "assistant_message",
        message: { role: "assistant", content: `selectable line number ${i}` },
      });
    }
    await tick(200);

    // Enter selection mode: the SELECT hint replaces the scroll hint.
    stdin.write(CTRL_E);
    await waitFor(ui, (f) => f.includes("SELECT"));

    // Press, drag across a filled row, release. With the viewport full every
    // row has content, so this selects a real span and the release copies it.
    stdin.write(down(1, 2));
    stdin.write(drag(24, 2));
    stdin.write(up(24, 2));

    await waitFor(seen, (f) => /⧉ copied \d+ chars to the clipboard/.test(f), 3000);
    expect(seen()).toMatch(/⧉ copied \d+ chars/);

    // Prove the CONTENT reached the clipboard, not just that a copy fired. On a
    // non-TTY test process copyToClipboard falls to OSC 52, whose payload is the
    // selected text base64-encoded in an ESC]52;c;<b64> sequence written to
    // stdout. Decode it and confirm it is a real slice of a projected line.
    const osc = seen().match(/\]52;c;([A-Za-z0-9+/=]+)/);
    expect(osc, "an OSC 52 clipboard write was emitted").not.toBeNull();
    const copied = Buffer.from(osc?.[1] ?? "", "base64").toString("utf8");
    expect(copied.length).toBeGreaterThan(0);
    expect(copied).toMatch(/selectable line number/);

    // A successful copy leaves selection mode on its own (like a terminal's own
    // drag-select), so the SELECT hint is gone and the transcript is back.
    await waitFor(ui, (f) => !f.includes("SELECT"), 3000);

    unmount();
  });
});
