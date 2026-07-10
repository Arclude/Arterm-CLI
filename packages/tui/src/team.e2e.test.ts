import type { Agent, AutonomyFleetRunner, Tool } from "@arterm/core";
import { AutonomyEngine, EventBus, defaultConfig } from "@arterm/core";
import { render } from "ink-testing-library";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { App } from "./App.js";
import type { Session } from "./types.js";

const ENTER = "\r";
const tick = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Poll the rendered frame until `pred` holds, or throw after `timeout` ms. */
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

const taskDone: Tool = {
  name: "task_done",
  description: "",
  parameters: {},
  permission: "allow",
  category: "read",
  execute: async () => ({ output: "" }),
};

/**
 * End-to-end: the REAL core AutonomyEngine in team mode + a REAL EventBus wired
 * into the REAL <App>. Only the model (agent.plan/assess/run) and the fleet
 * runner are faked; the fleet runner emits the same id-keyed member events the
 * CLI session wiring emits. Proves the whole /team chain: slash command →
 * roster → live member board (state + activity + files) → patch lines →
 * completion summary.
 */
describe("/team end-to-end (real AutonomyEngine ↔ App)", () => {
  it("drives the live team board from roster to completion", async () => {
    const bus = new EventBus();

    // plan #1 = roster, plan #2 = round-1 assignments; assess ends the run.
    let planCall = 0;
    const agent = {
      model: "qwen2.5:7b",
      effectiveContextWindow: () => 8192,
      reset: () => {},
      tools: [] as Tool[],
      setTools: () => {},
      history: [] as { role: string; content: string }[],
      run: async () => {},
      assess: async () => ({ done: true, note: "both changes landed" }),
      plan: async () => {
        planCall++;
        if (planCall === 1) {
          return JSON.stringify([
            {
              name: "refactorer",
              description: "cleans up the parser",
              instruction: "Refactor carefully.",
            },
            { name: "test-writer", description: "adds tests", instruction: "Write vitest tests." },
          ]);
        }
        return JSON.stringify([
          { member: "refactorer", task: "refactor parser.ts" },
          { member: "test-writer", task: "add parser tests" },
        ]);
      },
    } as unknown as Agent;

    // Mimic the CLI session's runFleetTasks: id-keyed member state + activity +
    // patch events on the shared bus, with delays so the "running" frame renders.
    const runFleet: AutonomyFleetRunner = async (tasks) => {
      for (const [i, t] of tasks.entries()) {
        const id = t.id ?? `m${i}`;
        const name = t.role ?? "member";
        bus.emit({ type: "team_member_state", id, name, state: "running", task: t.task });
        await tick(40);
        bus.emit({
          type: "team_member_event",
          id,
          name,
          event: {
            type: "tool_call",
            call: { id: `c${i}`, name: i === 0 ? "edit" : "write", arguments: {} },
          },
        });
        await tick(160);
        bus.emit({
          type: "team_member_state",
          id,
          name,
          state: "done",
          task: t.task,
          filesChanged: i + 1,
        });
        bus.emit({ type: "team_patch", id, name, ok: true, files: i + 1 });
      }
      return tasks.map((t) => ({ ...t, output: "ok" }));
    };

    const autonomy = new AutonomyEngine(agent, bus, taskDone, { mode: "team", runFleet });

    const noop = (): void => {};
    const session = {
      agent,
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
      autonomy,
      sdd: { state: "idle", run: async () => {}, pause: noop, resume: noop, stop: noop },
      mcpServers: [],
      plugins: [],
      skills: [],
      getSkillBody: () => undefined,
      agentDefs: [],
    } as unknown as Session;

    const { stdin, lastFrame, unmount } = render(createElement(App, { session }));
    await tick();

    stdin.write("/team refactor the parser and add tests");
    await tick();
    stdin.write(ENTER);

    // Roster lands: header line + board seeded with both members pending.
    await waitFor(lastFrame, (f) => f.includes("⚑ team") && f.includes("test-writer"));

    // A member is RUNNING with live tool activity on its board row.
    await waitFor(lastFrame, (f) => f.includes("▸ refactorer") && f.includes("⚙ edit"));
    console.log(`\n──── FRAME: member running (live activity) ────\n${lastFrame()}\n`);

    // Both members reach DONE with their changed-file counts.
    await waitFor(lastFrame, (f) => f.includes("2/2 done"));

    // Patch-applied lines + the completion summary hit the transcript.
    await waitFor(lastFrame, (f) => f.includes("team run complete"));
    const final = lastFrame() ?? "";
    console.log(`\n──── FRAME: run complete ────\n${final}\n`);
    expect(final).toContain("✓ refactorer");
    expect(final).toContain("✓ test-writer");
    expect(final).toContain("patch applied");
    expect(planCall).toBe(2);

    // Board navigation: ↓ selects the second member, Enter opens its activity
    // feed (the bridged tool_call landed there), Esc closes it again.
    stdin.write("[B"); // down arrow
    await tick();
    stdin.write(ENTER);
    await waitFor(lastFrame, (f) => f.includes("⚙ test-writer") && f.includes("⚙ write"));
    console.log(`\n──── FRAME: member drill-down ────\n${lastFrame()}\n`);
    stdin.write(""); // esc
    await waitFor(lastFrame, (f) => !f.includes("⚙ write"));
    unmount();
  });
});
