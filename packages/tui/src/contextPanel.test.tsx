import type { ContextBreakdown } from "@arterm/core";
import { render } from "ink-testing-library";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { ContextPanel, type ContextPanelProps } from "./ContextPanel.js";

const BREAKDOWN: ContextBreakdown = {
  system: 2400,
  tools: 3100,
  conversation: 7200,
  toolResults: 11300,
  total: 24000,
  messages: 42,
  nativeTools: true,
};

function panel(props: Partial<ContextPanelProps> = {}): string {
  const { lastFrame } = render(
    createElement(ContextPanel, {
      used: 24500,
      window: 32768,
      estimated: false,
      breakdown: BREAKDOWN,
      compactAt: 0.75,
      compactions: { count: 0 },
      cleared: 0,
      members: [],
      columns: 100,
      ...props,
    }),
  );
  return lastFrame() ?? "";
}

describe("the context panel", () => {
  it("says what is filling the window, not only how full it is", () => {
    // The distinction the status bar's gauge cannot make: 75% of tool output
    // and 75% of conversation are different problems, and only one of them is
    // fixed by compacting.
    const frame = panel();
    expect(frame).toContain("tool results");
    expect(frame).toContain("conversation");
    expect(frame).toContain("47%"); // tool results' share of the total
  });

  it("names how much room is left before auto-compaction, not just the threshold", () => {
    // A percentage does not say how much room is actually left before the
    // history is rewritten under the user.
    expect(panel({ used: 20000 })).toMatch(/until auto-compact \(75%\)/);
    // Past the threshold there is no room left to report — say that instead of
    // reporting zero, which reads like a measurement.
    expect(panel({ used: 30000 })).toContain("auto-compact due");
  });

  it("distinguishes a measurement from an estimate", () => {
    // A local backend that reports no usage produces a gauge built entirely
    // from a heuristic. Showing both the same way claims a precision the
    // number does not have.
    expect(panel({ estimated: false })).toContain("reported by the provider");
    expect(panel({ estimated: true })).toContain("estimated");
  });

  it("explains where the tool schemas went on a text-protocol model", () => {
    // `tools: 0` with no explanation reads as a bug. On these models the
    // schemas are part of the system message, and counting them twice would
    // inflate the only number a reader can act on.
    const frame = panel({
      breakdown: { ...BREAKDOWN, tools: 0, nativeTools: false },
    });
    // No schema ROW (the explanation below mentions the words, deliberately).
    expect(frame.split("\n").some((l) => /^\s*│?\s*tool schemas\s+[█░]/.test(l))).toBe(false);
    expect(frame).toContain("takes tool schemas in the prompt");
  });

  it("keeps a record of what already reshaped the history", () => {
    // The events announcing a compaction scroll away, and "why is the history
    // shorter than what I remember saying" is what the panel is for.
    const frame = panel({
      compactions: { count: 2, last: { before: 84, after: 12 } },
      cleared: 3,
    });
    expect(frame).toContain("2 compactions");
    expect(frame).toContain("84 → 12 messages");
    expect(frame).toContain("3 stale tool results cleared");
  });

  it("says plainly when nothing has been compacted yet", () => {
    expect(panel()).toContain("no compaction yet this session");
  });

  it("shows each worker's own fill beside the session's", () => {
    // A fan-out has one context per agent. The board shows them per cell; this
    // is the one place they can be compared to each other and to the leader's.
    const frame = panel({
      members: [
        {
          id: "w1",
          name: "refactorer",
          description: "",
          adhoc: false,
          state: "running",
          ctxUsed: 28000,
          ctxWindow: 32768,
        },
        {
          id: "w2",
          name: "tester",
          description: "",
          adhoc: false,
          state: "running",
          ctxUsed: 4000,
          ctxWindow: 32768,
        },
      ],
    });
    expect(frame).toContain("AGENTS 2");
    expect(frame).toContain("refactorer");
    expect(frame).toContain("85%");
    expect(frame).toContain("12%");
  });

  it("shows the fill before the composition has been measured", () => {
    // The breakdown reads project instructions off disk; the panel must be
    // useful in the frame before that resolves rather than rendering empty.
    const frame = panel({ breakdown: undefined });
    expect(frame).toContain("fill");
    expect(frame).toContain("measuring…");
  });
});

/**
 * The command, end to end. Esc is the interesting half: the same key aborts a
 * running turn, and closing a view the user just opened has to come first.
 */
describe("/context in a session", () => {
  it("opens on the command and closes on Esc", async () => {
    const { EventBus, PermissionBroker, defaultConfig } = await import("@arterm/core");
    const { App } = await import("./App.js");
    const bus = new EventBus();
    const noop = (): void => {};
    const session = {
      agent: {
        model: "qwen2.5:7b",
        effectiveContextWindow: () => 8192,
        reset: noop,
        run: async () => {},
        contextBreakdown: async () => BREAKDOWN,
      },
      bus,
      config: { ...defaultConfig() },
      providerLabel: "ollama",
      toolCount: 7,
      yolo: false,
      setAsker: noop,
      permissionBroker: new PermissionBroker(bus),
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
      permissionMode: "ask",
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
    } as never;

    const { stdin, frames, unmount } = render(createElement(App, { session }));
    const ui = () => [...frames].reverse().find((f) => f.includes("ARTERM")) ?? "";
    const tick = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms));
    const waitFor = async (pred: (f: string) => boolean): Promise<void> => {
      for (let i = 0; i < 100; i++) {
        if (pred(ui())) return;
        await tick(20);
      }
      throw new Error(`condition not met; last view:\n${ui()}`);
    };
    await tick();

    stdin.write("/context");
    await tick();
    stdin.write("\r");
    await waitFor((f) => f.includes("CONTEXT") && f.includes("COMPOSITION"));

    stdin.write("\u001B");
    await waitFor((f) => !f.includes("COMPOSITION"));

    unmount();
  });
});
