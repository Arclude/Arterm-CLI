import type { AgentEvent, SddAsk } from "@arterm/core";
import { defaultConfig } from "@arterm/core";
import { render } from "ink-testing-library";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { App } from "./App.js";
import type { Session } from "./types.js";

const ENTER = "\r";
const ESC = String.fromCharCode(27);

/** Let React flush state + ink re-subscribe useInput before the next keystroke. */
const tick = (ms = 25): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** /sdd's ask signature. */
type Ask = SddAsk;

/**
 * A Session mock complete enough to mount <App> and drive the /sdd flow. `sdd.run`
 * is injectable so a test can either exercise the interview (call `ask`) or just
 * emit board events on the returned live bus.
 */
function makeSession(runImpl: (brief: string, ask?: Ask) => Promise<void>): {
  session: Session;
  emit: (event: AgentEvent) => void;
} {
  const listeners = new Set<(event: AgentEvent) => void>();
  const emit = (event: AgentEvent): void => {
    for (const l of listeners) l(event);
  };
  const noop = (): void => {};
  const session = {
    agent: {
      model: "qwen2.5:7b",
      effectiveContextWindow: () => 8192,
      reset: noop,
      run: async () => {},
    },
    bus: {
      on: (l: (event: AgentEvent) => void) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
    },
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
    sdd: {
      state: "idle",
      run: (brief: string, ask?: SddAsk) => runImpl(brief, ask),
      pause: noop,
      resume: noop,
      stop: noop,
    },
    mcpServers: [],
    plugins: [],
    skills: [],
    getSkillBody: () => undefined,
  } as unknown as Session;
  return { session, emit };
}

describe("/sdd interactive interview", () => {
  it("presents the model's questions, collects typed answers, resolves the ask promise", async () => {
    let answers: string[] | undefined;
    const { session } = makeSession(async (_brief, ask) => {
      if (ask) answers = await ask(["What framework?", "Auth needed?"]);
    });
    const { stdin, lastFrame, unmount } = render(createElement(App, { session }));
    await tick();

    // Kick off /sdd — the mock run() calls ask(), which opens the interview overlay.
    stdin.write("/sdd build a blog");
    await tick();
    stdin.write(ENTER);
    await tick();

    // First question is shown and awaiting an answer.
    expect(lastFrame()).toContain("interview");
    expect(lastFrame()).toContain("What framework?");

    // Answer the first, advance to the second, answer it.
    stdin.write("React");
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(lastFrame()).toContain("Auth needed?");
    stdin.write("yes");
    await tick();
    stdin.write(ENTER);
    await tick();

    // Last Enter resolves the awaited ask() with both answers.
    expect(answers).toEqual(["React", "yes"]);
    unmount();
  });

  it("Esc skips the remaining questions, resolving blanks for them", async () => {
    let answers: string[] | undefined;
    const { session } = makeSession(async (_brief, ask) => {
      if (ask) answers = await ask(["Q1?", "Q2?", "Q3?"]);
    });
    const { stdin, unmount } = render(createElement(App, { session }));
    await tick();

    stdin.write("/sdd anything");
    await tick();
    stdin.write(ENTER);
    await tick();

    stdin.write("first");
    await tick();
    stdin.write(ENTER); // answers Q1, moves to Q2
    await tick();
    stdin.write(ESC); // skip the rest
    await tick();

    expect(answers).toEqual(["first", "", ""]);
    unmount();
  });
});

describe("/sdd kanban board", () => {
  it("seeds from sdd_graph and moves tasks between columns on sdd_task_state", async () => {
    const { session, emit } = makeSession(async () => {});
    const { lastFrame, unmount } = render(createElement(App, { session }));
    await tick();

    emit({
      type: "sdd_graph",
      tasks: [
        { id: "t1", title: "Design", dependsOn: [], state: "pending" },
        { id: "t2", title: "Build", dependsOn: ["t1"], state: "pending" },
      ],
    });
    await tick();

    const seeded = lastFrame() ?? "";
    expect(seeded).toContain("/sdd board");
    expect(seeded).toContain("PENDING (2)");
    expect(seeded).toContain("t1");

    // t1 starts running, then finishes; t2 stays pending.
    emit({ type: "sdd_task_state", id: "t1", title: "Design", state: "running" });
    await tick();
    expect(lastFrame() ?? "").toContain("RUNNING (1)");

    emit({ type: "sdd_task_state", id: "t1", title: "Design", state: "done" });
    await tick();
    const after = lastFrame() ?? "";
    expect(after).toContain("DONE (1)");
    expect(after).toContain("PENDING (1)");
    unmount();
  });
});
