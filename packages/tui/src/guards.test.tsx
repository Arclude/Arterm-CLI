import { EventBus, PermissionBroker, defaultConfig } from "@arterm/core";
import { render } from "ink-testing-library";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { App } from "./App.js";
import { formatMemberEvent } from "./teamFeed.js";
import type { Session } from "./types.js";

const tick = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor(view: () => string, pred: (f: string) => boolean, timeout = 4000) {
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
      reset: noop,
      run: async () => {},
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
  } as unknown as Session;
}

/**
 * The guards are the reason an unattended run is safe to leave alone — and
 * every one of them was emitted by core and rendered nowhere. A run that
 * repeated itself, was granted more steps, backed off, or had its request
 * refused for budget looked, on screen, like a run that was simply quiet.
 */
describe("guard events reach the transcript", () => {
  const cases: [string, Record<string, unknown>, RegExp][] = [
    ["loop_detected", { streak: 3, note: "same edit 3×" }, /looping.*3×.*steered/],
    ["loop_cut", { streak: 5 }, /turn cut.*5×/],
    [
      "autonomy_extended",
      { newLimit: 60, reason: "tool calls since last grant" },
      /extended to 60/,
    ],
    ["budget_warning", { spent: "$0.42" }, /budget.*\$0\.42.*wrapping up/],
    ["budget_exceeded", { spent: "$1.00" }, /budget exhausted.*refused before it was sent/],
    ["autonomy_backoff", { ms: 2000, attempt: 3 }, /retrying in 2\.0s \(attempt 3\)/],
  ];

  for (const [type, payload, expected] of cases) {
    it(`renders ${type}`, async () => {
      const bus = new EventBus();
      const { frames, unmount } = render(createElement(App, { session: fakeSession(bus) }));
      const ui = () => [...frames].reverse().find((f) => f.includes("ARTERM")) ?? "";
      await tick();

      bus.emit({ type, ...payload } as never);
      await waitFor(ui, (f) => expected.test(f));

      unmount();
    });
  }

  it("keeps the eternal journal's routine steps out of the transcript", async () => {
    // One line per step, most of them `ok`. Printing all of them buries the
    // transcript in a status the screen already shows; the steps worth a line
    // are the ones that did not go well.
    const bus = new EventBus();
    const { frames, unmount } = render(createElement(App, { session: fakeSession(bus) }));
    const ui = () => [...frames].reverse().find((f) => f.includes("ARTERM")) ?? "";
    await tick();

    bus.emit({ type: "autonomy_journal", status: "ok", note: "edited two files" });
    bus.emit({ type: "autonomy_journal", status: "idle", note: "nothing to do" });
    bus.emit({ type: "autonomy_journal", status: "verify-fail", note: "tests still red" });
    await waitFor(ui, (f) => f.includes("tests still red"));

    expect(ui()).not.toContain("edited two files");
    expect(ui()).not.toContain("nothing to do");

    unmount();
  });

  it("shows a directed team message, not every member's round recap", async () => {
    const bus = new EventBus();
    const { frames, unmount } = render(createElement(App, { session: fakeSession(bus) }));
    const ui = () => [...frames].reverse().find((f) => f.includes("ARTERM")) ?? "";
    await tick();

    // A `result` is the round recap — the board and the round summary already
    // carry it. A `message` is one worker deliberately telling another
    // something, and had no home on screen at all.
    bus.emit({
      type: "team_message",
      round: 1,
      from: "m1",
      fromName: "refactorer",
      kind: "result",
      text: "ported the parser",
    });
    bus.emit({
      type: "team_message",
      round: 1,
      from: "m1",
      fromName: "refactorer",
      to: "m2",
      toName: "tester",
      kind: "message",
      text: "the parser moved to core/parse.ts",
    });
    await waitFor(ui, (f) => f.includes("refactorer → tester"));

    expect(ui()).toContain("core/parse.ts");
    expect(ui()).not.toContain("ported the parser");

    unmount();
  });
});

/**
 * `subagent.ts` bridges these four deliberately — a worker that hit its cap
 * looked identical to one that finished, and a looping worker looked like a
 * busy one. The feed formatter dropped them anyway, so the drill-down showed
 * the silence rather than the reason for it.
 */
describe("a worker's feed says why it stopped", () => {
  it("formats the bridged lifecycle events the formatter used to skip", () => {
    expect(formatMemberEvent({ type: "loop_detected", streak: 3, note: "n" })).toMatch(/3×/);
    expect(formatMemberEvent({ type: "loop_cut", streak: 5 })).toMatch(/cut.*5×/);
    expect(
      formatMemberEvent({ type: "run_limit", kind: "iterations", limit: 12, used: 12 }),
    ).toMatch(/iteration cap reached \(12\)/);
    expect(formatMemberEvent({ type: "run_limit", kind: "tokens", limit: 900, used: 900 })).toMatch(
      /token budget/,
    );
    expect(formatMemberEvent({ type: "autonomy_done", summary: "wrote the test" })).toMatch(
      /wrote the test/,
    );
    expect(formatMemberEvent({ type: "autonomy_stopped", reason: "cap" })).toMatch(/cap/);
  });
});
