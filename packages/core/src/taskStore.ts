/**
 * A task graph the MODEL builds, on the same shape `/sdd` executes.
 *
 * The third of three surfaces, and the one that has to justify itself against
 * the other two. `todo` is a flat list of steps for one agent working through
 * them in order; `/sdd` is a graph cut from a spec by the SDD runner and then
 * executed in waves. The gap between them is a graph the model writes itself —
 * "these four things, and B needs A first" — for work that is too structured
 * for a list and did not arrive as a spec.
 *
 * That gap is only worth code because of ONE query: {@link TaskStore.ready}.
 * Dependencies in a list a single agent walks in order add nothing — the order
 * already says it. Dependencies matter when something asks "what can run NOW,
 * in parallel", which is what a fan-out needs and what a flat list cannot
 * answer. This deliberately reuses `SddTask` rather than inventing a parallel
 * type, so a graph the model wrote can be handed to the same executor.
 *
 * The write contract differs from `todo`'s on purpose. `todo` is replaced
 * wholesale because it is short and its ids are throwaway. A task graph
 * carries descriptions and dependency edges; forcing a full resend to mark one
 * task done would spend hundreds of tokens per state change and invite the
 * model to paraphrase the descriptions it is resending. So: `replace` sets the
 * graph, `setState` moves one task.
 */

import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { ARTERM_HOME } from "./config.js";
import type { SddTaskState } from "./eventBus.js";
import type { SddTask } from "./sdd.js";

export interface TaskWriteResult {
  ok: boolean;
  error?: string;
  tasks: SddTask[];
}

/** Where a session's task graph lives. */
export function taskPath(sessionId: string, home: string = ARTERM_HOME): string {
  return join(home, "tasks", `${sessionId}.json`);
}

/**
 * Validate a graph before it is stored.
 *
 * Both checks are about a graph that cannot be executed rather than a graph
 * that is merely untidy: an edge to a task that does not exist, and a cycle.
 * A cycle is the important one — nothing in it is ever `ready`, so a run
 * holding a cyclic graph waits forever on work it has already been given, and
 * the symptom (an idle fleet) points nowhere near the cause.
 */
export function validateGraph(tasks: SddTask[]): string | undefined {
  const byId = new Map<string, SddTask>();
  for (const t of tasks) {
    if (!t.id || !t.title) return "every task needs an id and a title";
    if (byId.has(t.id)) return `duplicate task id "${t.id}"`;
    byId.set(t.id, t);
  }
  for (const t of tasks) {
    for (const dep of t.dependsOn) {
      if (!byId.has(dep)) return `task "${t.id}" depends on "${dep}", which does not exist`;
    }
  }
  // Depth-first cycle detection: white → grey → black.
  const state = new Map<string, 0 | 1 | 2>();
  const walk = (id: string, path: string[]): string | undefined => {
    const mark = state.get(id) ?? 0;
    if (mark === 1) return `dependency cycle: ${[...path, id].join(" → ")}`;
    if (mark === 2) return undefined;
    state.set(id, 1);
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      const cycle = walk(dep, [...path, id]);
      if (cycle) return cycle;
    }
    state.set(id, 2);
    return undefined;
  };
  for (const t of tasks) {
    const cycle = walk(t.id, []);
    if (cycle) return cycle;
  }
  return undefined;
}

export class TaskStore {
  private tasks: SddTask[] = [];

  constructor(
    private readonly file: string,
    private readonly onChange?: (tasks: SddTask[]) => void,
  ) {}

  /** Load from disk, if there is anything there. Corrupt files are ignored. */
  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, "utf8")) as { tasks?: SddTask[] };
      if (Array.isArray(parsed.tasks) && !validateGraph(parsed.tasks)) {
        this.tasks = parsed.tasks;
      }
    } catch {
      // No graph, or an unreadable one — a run without tasks, not a failed run.
    }
  }

  list(): SddTask[] {
    return this.tasks.map((t) => ({ ...t, dependsOn: [...t.dependsOn] }));
  }

  async replace(tasks: SddTask[]): Promise<TaskWriteResult> {
    const error = validateGraph(tasks);
    if (error) return { ok: false, error, tasks: this.list() };
    this.tasks = tasks.map((t) => ({ ...t, dependsOn: [...t.dependsOn] }));
    await this.persist();
    return { ok: true, tasks: this.list() };
  }

  async setState(id: string, state: SddTaskState, output?: string): Promise<TaskWriteResult> {
    const task = this.tasks.find((t) => t.id === id);
    if (!task) return { ok: false, error: `no task "${id}"`, tasks: this.list() };
    task.state = state;
    if (output !== undefined) task.output = output;
    await this.persist();
    return { ok: true, tasks: this.list() };
  }

  /**
   * Tasks that can start right now: pending, with every dependency done.
   *
   * This is the query the whole file exists for. A `failed` or `blocked`
   * dependency does NOT unblock its dependents — work built on something that
   * did not happen is work built on nothing, and letting it start is how a
   * fan-out produces a pile of confidently wrong output.
   */
  ready(): SddTask[] {
    const done = new Set(this.tasks.filter((t) => t.state === "done").map((t) => t.id));
    return this.list().filter(
      (t) => t.state === "pending" && t.dependsOn.every((d) => done.has(d)),
    );
  }

  /** Tasks that can never start, because something they need failed. */
  blocked(): SddTask[] {
    const dead = new Set(
      this.tasks.filter((t) => t.state === "failed" || t.state === "blocked").map((t) => t.id),
    );
    if (dead.size === 0) return [];
    return this.list().filter((t) => t.state === "pending" && t.dependsOn.some((d) => dead.has(d)));
  }

  private async persist(): Promise<void> {
    await fs.mkdir(dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, `${JSON.stringify({ tasks: this.tasks }, null, 2)}\n`, "utf8");
    this.onChange?.(this.list());
  }
}
