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

  it("says at boot that shell commands are confined, and stays quiet when they are not", async () => {
    // The boundary is now the default for attended sessions, where nothing else
    // announces it: the `◆ sandbox ON` line is written under `--autonomous`
    // only, and the boot warnings it would join go to stderr, which fullscreen
    // paints over. Without this line the first sign of a control doing its job
    // is a shell command failing to write one directory over — which reads as a
    // broken tool. The negative half matters as much: a session with no
    // boundary must not claim one, so the text is driven by the session's own
    // description rather than by the config it was built from.
    const bus = new EventBus();
    const confined = fakeSession(bus);
    (confined as unknown as { sandboxDescription: string }).sandboxDescription =
      "writes confined to /tmp/x; egress: 12 allowed domains";
    const { frames, unmount } = render(createElement(App, { session: confined }));
    const ui = () => [...frames].reverse().find((f) => f.includes("ARTERM")) ?? "";
    await waitFor(ui, (f) => /sandbox — writes confined to \/tmp\/x/.test(f));
    unmount();

    const bare = render(createElement(App, { session: fakeSession(new EventBus()) }));
    const bareUi = () => [...bare.frames].reverse().find((f) => f.includes("ARTERM")) ?? "";
    await waitFor(bareUi, (f) => f.includes("ARTERM"));
    await tick(80);
    expect(bareUi()).not.toContain("sandbox —");
    bare.unmount();
  });

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

/**
 * The leader is the one agent with no cell on the swarm board, by design — its
 * spend is named in the header and its liveness was declared "the status bar's
 * job". It was not doing that job: `plan()` emits no `turn_start`, so between
 * rounds the screen showed a finished board (`3/3 done · 0 LIVE`), a frozen step
 * counter and an idle status bar, while the call deciding the next round ran for
 * minutes. Nothing was wrong and nothing said so.
 */
describe("the leader's own call is visible while it runs", () => {
  it("says the leader is thinking, and stops saying it when the call returns", async () => {
    const bus = new EventBus();
    const { frames, unmount } = render(createElement(App, { session: fakeSession(bus) }));
    const ui = () => [...frames].reverse().find((f) => f.includes("ARTERM")) ?? "";
    await tick();

    // The banner only exists during a goal run — that is where the leader lives.
    bus.emit({ type: "goal_set", goal: "build three modules", mode: "team" });
    bus.emit({ type: "autonomy_step", step: 2 });
    bus.emit({ type: "leader_call", kind: "plan", active: true });
    await waitFor(ui, (f) => f.includes("leader thinking"));

    bus.emit({ type: "leader_call", kind: "plan", active: false });
    await waitFor(ui, (f) => !f.includes("leader thinking"));
    // The goal banner itself stays — only the leader indicator clears.
    expect(ui()).toContain("build three modules");

    unmount();
  });
});
