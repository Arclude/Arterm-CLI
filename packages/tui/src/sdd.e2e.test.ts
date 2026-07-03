import type { Agent, SddStore } from "@arterm/core";
import { EventBus, SddRunner, defaultConfig } from "@arterm/core";
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

/**
 * End-to-end: the REAL core SddRunner + a REAL EventBus wired into the REAL <App>.
 * Only the model call (agent.plan) and the fleet runner are faked — everything else
 * (interview ordering, ask bridge, spec build, DAG execution, event emission, the
 * overlay + kanban board) is the production code path. Proves the whole /sdd chain.
 */
describe("/sdd end-to-end (real SddRunner ↔ App)", () => {
  it("runs interview → spec → DAG and drives the live board to completion", async () => {
    const bus = new EventBus();

    // agent.plan is called twice: first for the interview questions, then for the
    // spec + task graph. Return canned, parseable outputs for each.
    let planCall = 0;
    const agent = {
      model: "qwen2.5:7b",
      effectiveContextWindow: () => 8192,
      reset: () => {},
      plan: async () => {
        planCall++;
        if (planCall === 1) return JSON.stringify(["What framework?", "Auth needed?"]);
        const graph = JSON.stringify({
          tasks: [
            { id: "t1", title: "Design schema", dependsOn: [] },
            { id: "t2", title: "Build UI", dependsOn: ["t1"] },
          ],
        });
        return `# Blog\n\nA simple blog spec.\n\n\`\`\`json\n${graph}\n\`\`\`\n`;
      },
    } as unknown as Agent;

    // Fleet runner: every dispatched task succeeds (output must not start with
    // "sub-agent failed"), so the DAG walks t1 → t2 to completion.
    const runFleet = async (tasks: { task: string; role?: string }[]) =>
      tasks.map((t) => ({ task: t.task, output: "ok", steps: 0 }));

    const store: SddStore = {
      save: async () => "/tmp/spec-e2e",
      load: async () => undefined,
      list: async () => [],
    };
    const sdd = new SddRunner(agent, bus, runFleet as never, store, {
      maxQuestions: 4,
      maxTasks: 12,
      fanout: 4,
    });

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
      autonomy: {
        state: "idle",
        start: async () => {},
        pause: noop,
        resume: noop,
        stop: noop,
        steer: noop,
        setMode: () => true,
      },
      sdd,
      mcpServers: [],
      plugins: [],
      skills: [],
      getSkillBody: () => undefined,
    } as unknown as Session;

    const { stdin, lastFrame, unmount } = render(createElement(App, { session }));
    await tick();

    // Kick off /sdd — the real runner asks the model, emits sdd_interview, then
    // calls our ask bridge, which opens the interview overlay.
    stdin.write("/sdd build a blog");
    await tick();
    stdin.write(ENTER);
    await waitFor(lastFrame, (f) => f.includes("What framework?"));

    // Answer both interview questions.
    stdin.write("React");
    await tick();
    stdin.write(ENTER);
    await waitFor(lastFrame, (f) => f.includes("Auth needed?"));
    stdin.write("yes");
    await tick();
    stdin.write(ENTER);

    // The runner now builds the spec + graph (plan #2) and seeds the board.
    await waitFor(lastFrame, (f) => f.includes("/sdd board"));
    expect(lastFrame() ?? "").toContain("Design schema");

    // The DAG walks t1 → t2; wait for both tasks to land in DONE.
    await waitFor(lastFrame, (f) => f.includes("DONE (2)"));

    // And the real runner emitted sdd_done, rendered to the transcript.
    await waitFor(lastFrame, (f) => f.includes("/sdd complete"));
    expect(planCall).toBe(2);
    unmount();
  });
});
