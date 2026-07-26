import { EventBus, PermissionBroker, defaultConfig } from "@arterm/core";
import { render } from "ink-testing-library";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { App } from "./App.js";
import type { Session } from "./types.js";

const ENTER = "\r";
const UP = "\u001B[A";
const DOWN = "\u001B[B";
const CTRL_UP = "\u001B[1;5A";
const CTRL_DOWN = "\u001B[1;5B";
/** Alt+arrow — an ESC-prefixed arrow, what terminals that drop Ctrl+arrow send. */
const ALT_UP = "\u001B\u001B[A";
const ALT_DOWN = "\u001B\u001B[B";
const TAB = "\t";
const ESC = "\u001B";

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
 * The parallel/fleet board: a `/goal` run in parallel mode gets the same live,
 * navigable board as `/team`, keyed on the round-scoped subtask ids the engine
 * now stamps onto every dispatched task.
 */
describe("fleet board (parallel autonomy)", () => {
  it("shows the round's subtasks, their live activity, and drills into one", async () => {
    const bus = new EventBus();
    const { stdin, frames, unmount } = render(createElement(App, { session: fakeSession(bus) }));
    const ui = () => [...frames].reverse().find((f) => f.includes("ARTERM")) ?? "";
    await tick();

    bus.emit({
      type: "autonomy_fleet_round",
      round: 1,
      tasks: [
        { id: "r1-1", task: "port the parser", role: "refactorer" },
        { id: "r1-2", task: "cover the parser", role: "tester" },
      ],
    });

    // Board seeded, labelled as a fleet (not a team), with both rows pending.
    await waitFor(ui, (f) => f.includes("⛓ fleet") && f.includes("refactorer"));
    expect(ui()).toContain("tester");
    expect(ui()).toContain("^↑↓ subtask");

    // A subtask goes RUNNING and its bridged tool call shows as live activity.
    bus.emit({
      type: "team_member_state",
      id: "r1-1",
      name: "refactorer",
      state: "running",
      task: "port the parser",
    });
    bus.emit({
      type: "team_member_event",
      id: "r1-1",
      name: "refactorer",
      event: { type: "tool_call", call: { id: "c1", name: "edit", arguments: {} } },
    });
    await waitFor(ui, (f) => f.includes("▸ refactorer") && f.includes("⚙ edit"));

    bus.emit({
      type: "team_member_state",
      id: "r1-2",
      name: "tester",
      state: "running",
      task: "cover the parser",
    });
    bus.emit({
      type: "team_member_event",
      id: "r1-2",
      name: "tester",
      event: { type: "tool_call", call: { id: "c2", name: "write", arguments: {} } },
    });
    bus.emit({
      type: "team_member_state",
      id: "r1-2",
      name: "tester",
      state: "done",
      filesChanged: 2,
    });
    await waitFor(ui, (f) => f.includes("1/2 done"));

    // Ctrl+↓ selects the second subtask, Enter opens its feed, Esc closes it.
    stdin.write(CTRL_DOWN);
    await tick();
    stdin.write(ENTER);
    await waitFor(ui, (f) => f.includes("⚙ tester") && f.includes("⚙ write"));
    stdin.write(ESC);
    await waitFor(ui, (f) => !f.includes("⚙ tester"));

    unmount();
  });

  it("leaves plain ↑/↓ to the prompt history and moves the row on Ctrl+↑/↓", async () => {
    const bus = new EventBus();
    const { stdin, frames, unmount } = render(createElement(App, { session: fakeSession(bus) }));
    const ui = () => [...frames].reverse().find((f) => f.includes("ARTERM")) ?? "";
    await tick();

    bus.emit({
      type: "autonomy_fleet_round",
      round: 1,
      tasks: [
        { id: "r1-1", task: "port the parser", role: "refactorer" },
        { id: "r1-2", task: "cover the parser", role: "tester" },
      ],
    });
    await waitFor(ui, (f) => f.includes("refactorer") && f.includes("tester"));

    /** The name on the ❯-marked row. */
    const selectedRow = (): string =>
      ui()
        .split("\n")
        .find((l) => l.includes("❯")) ?? "";
    expect(selectedRow()).toContain("refactorer");

    // Plain ↓ / ↑ are prompt history now: the selection must not budge.
    stdin.write(DOWN);
    await tick();
    expect(selectedRow()).toContain("refactorer");
    stdin.write(UP);
    await tick();
    expect(selectedRow()).toContain("refactorer");

    // Ctrl+↓ moves it, and Ctrl+↑ wraps back around from the first row.
    stdin.write(CTRL_DOWN);
    await waitFor(
      () => selectedRow(),
      (l) => l.includes("tester"),
    );
    stdin.write(CTRL_UP);
    await waitFor(
      () => selectedRow(),
      (l) => l.includes("refactorer"),
    );
    stdin.write(CTRL_UP);
    await waitFor(
      () => selectedRow(),
      (l) => l.includes("tester"),
    );

    unmount();
  });

  it("steps to the next subtask on Tab while a drill-down is open, wrapping around", async () => {
    const bus = new EventBus();
    const { stdin, frames, unmount } = render(createElement(App, { session: fakeSession(bus) }));
    const ui = () => [...frames].reverse().find((f) => f.includes("ARTERM")) ?? "";
    await tick();

    bus.emit({
      type: "autonomy_fleet_round",
      round: 1,
      tasks: [
        { id: "r1-1", task: "port the parser", role: "refactorer" },
        { id: "r1-2", task: "cover the parser", role: "tester" },
      ],
    });
    await waitFor(ui, (f) => f.includes("refactorer") && f.includes("tester"));

    // Enter on the empty prompt opens the first row's feed; the header counts it.
    stdin.write(ENTER);
    await waitFor(ui, (f) => f.includes("⚙ refactorer") && f.includes("(1/2)"));
    // The hint drops ⏎ inspect and offers the bare arrows while the feed is open.
    expect(ui()).toContain("↑↓/⇥ subtask");

    // Tab walks to the second row, then wraps back to the first — feed stays open.
    stdin.write(TAB);
    await waitFor(ui, (f) => f.includes("⚙ tester") && f.includes("(2/2)"));
    stdin.write(TAB);
    await waitFor(ui, (f) => f.includes("⚙ refactorer") && f.includes("(1/2)"));

    unmount();
  });

  it("seeds the board from a bare spawn_parallel dispatch (fleet_start rows)", async () => {
    const bus = new EventBus();
    const { stdin, frames, unmount } = render(createElement(App, { session: fakeSession(bus) }));
    const ui = () => [...frames].reverse().find((f) => f.includes("ARTERM")) ?? "";
    await tick();

    // What the `spawn_parallel` tool produces: no plan event, just the dispatch
    // carrying its own minted rows.
    bus.emit({
      type: "fleet_start",
      count: 2,
      tasks: [
        { id: "f1-1", task: "read the tools package", role: "explorer" },
        { id: "f1-2", task: "read the providers package", role: "explorer" },
      ],
    });

    await waitFor(ui, (f) => f.includes("⛓ fleet") && f.includes("read the tools package"));
    expect(ui()).toContain("^↑↓ subtask");

    // The rows are navigable, exactly as a planned round's are.
    const selectedRow = (): string =>
      ui()
        .split("\n")
        .find((l) => l.includes("❯")) ?? "";
    stdin.write(CTRL_DOWN);
    await waitFor(
      () => selectedRow(),
      (l) => l.includes("read the providers package"),
    );

    unmount();
  });

  it("gives plain ↑/↓ to the rows while a drill-down is open, and back on close", async () => {
    const bus = new EventBus();
    const { stdin, frames, unmount } = render(createElement(App, { session: fakeSession(bus) }));
    const ui = () => [...frames].reverse().find((f) => f.includes("ARTERM")) ?? "";
    await tick();

    bus.emit({
      type: "autonomy_fleet_round",
      round: 1,
      tasks: [
        { id: "r1-1", task: "port the parser", role: "refactorer" },
        { id: "r1-2", task: "cover the parser", role: "tester" },
      ],
    });
    await waitFor(ui, (f) => f.includes("refactorer") && f.includes("tester"));

    // Enter opens the first row's feed; the hint now advertises plain ↑/↓ too.
    stdin.write(ENTER);
    await waitFor(ui, (f) => f.includes("⚙ refactorer") && f.includes("(1/2)"));
    expect(ui()).toContain("↑↓/⇥ subtask");

    // Plain ↓ / ↑ step the row instead of recalling history, and wrap.
    stdin.write(DOWN);
    await waitFor(ui, (f) => f.includes("⚙ tester") && f.includes("(2/2)"));
    stdin.write(UP);
    await waitFor(ui, (f) => f.includes("⚙ refactorer") && f.includes("(1/2)"));

    // Esc closes the feed and hands ↑/↓ back to the prompt history.
    stdin.write(ESC);
    await waitFor(ui, (f) => !f.includes("⚙ refactorer"));
    const selectedRow = (): string =>
      ui()
        .split("\n")
        .find((l) => l.includes("❯")) ?? "";
    stdin.write(DOWN);
    await tick();
    expect(selectedRow()).toContain("refactorer");

    unmount();
  });

  it("steps rows on Tab and Alt+arrows — for terminals that eat Ctrl+arrow", async () => {
    const bus = new EventBus();
    const { stdin, frames, unmount } = render(createElement(App, { session: fakeSession(bus) }));
    const ui = () => [...frames].reverse().find((f) => f.includes("ARTERM")) ?? "";
    await tick();

    bus.emit({
      type: "fleet_start",
      count: 3,
      tasks: [
        { id: "f1-1", task: "read tools", role: "explorer" },
        { id: "f1-2", task: "read providers", role: "explorer" },
        { id: "f1-3", task: "read memory", role: "explorer" },
      ],
    });
    await waitFor(ui, (f) => f.includes("read tools") && f.includes("read memory"));
    const selectedRow = (): string =>
      ui()
        .split("\n")
        .find((l) => l.includes("\u276f")) ?? "";
    expect(ui()).toContain("\u21e5/^\u2191\u2193 subtask");

    // Tab walks the rows with the feed CLOSED (the prompt has no completion to
    // offer), which is the binding no terminal can mangle.
    stdin.write(TAB);
    await waitFor(
      () => selectedRow(),
      (l) => l.includes("read providers"),
    );

    // Alt+arrows move it too, for terminals that drop the Ctrl modifier.
    stdin.write(ALT_DOWN);
    await waitFor(
      () => selectedRow(),
      (l) => l.includes("read memory"),
    );
    stdin.write(ALT_UP);
    await waitFor(
      () => selectedRow(),
      (l) => l.includes("read providers"),
    );

    unmount();
  });

  it("leaves Tab to slash-completion while the prompt has one to offer", async () => {
    const bus = new EventBus();
    const { stdin, frames, unmount } = render(createElement(App, { session: fakeSession(bus) }));
    const ui = () => [...frames].reverse().find((f) => f.includes("ARTERM")) ?? "";
    await tick();

    bus.emit({
      type: "fleet_start",
      count: 2,
      tasks: [
        { id: "f1-1", task: "read tools", role: "explorer" },
        { id: "f1-2", task: "read providers", role: "explorer" },
      ],
    });
    await waitFor(ui, (f) => f.includes("read tools"));
    const selectedRow = (): string =>
      ui()
        .split("\n")
        .find((l) => l.includes("\u276f")) ?? "";

    // "/comp" suggests /compact: Tab completes the command and the row stays put.
    stdin.write("/comp");
    await waitFor(ui, (f) => f.includes("/comp"));
    stdin.write(TAB);
    await waitFor(ui, (f) => f.includes("/compact"));
    expect(selectedRow()).toContain("read tools");

    unmount();
  });

  it("replaces the rows each round instead of accumulating them", async () => {
    const bus = new EventBus();
    const { frames, unmount } = render(createElement(App, { session: fakeSession(bus) }));
    const ui = () => [...frames].reverse().find((f) => f.includes("ARTERM")) ?? "";
    await tick();

    bus.emit({
      type: "autonomy_fleet_round",
      round: 1,
      tasks: [{ id: "r1-1", task: "first pass", role: "refactorer" }],
    });
    await waitFor(ui, (f) => f.includes("first pass"));

    bus.emit({
      type: "autonomy_fleet_round",
      round: 2,
      tasks: [{ id: "r2-1", task: "second pass", role: "tester" }],
    });
    await waitFor(ui, (f) => f.includes("second pass"));
    // Round 1's row is gone — its subtask is finished work, not a standing member.
    expect(ui()).not.toContain("first pass");
    expect(ui()).toContain("0/1 done");

    unmount();
  });
});
