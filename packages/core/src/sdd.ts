import type { Agent } from "./agent.js";
import type { AutonomyTask, AutonomyTaskResult } from "./autonomy.js";
import type { EventBus, SddTaskState } from "./eventBus.js";
import { RunGate } from "./runGate.js";
import type { SddStore } from "./sddStore.js";
import { availableRoles } from "./subagent.js";

/** Runs a batch of independent tasks concurrently and returns ordered results. */
export type SddFleetRunner = (
  tasks: AutonomyTask[],
  signal: AbortSignal,
) => Promise<AutonomyTaskResult[]>;

/** Collects answers to interview questions from the host (TUI/CLI). */
export type SddAsk = (questions: string[]) => Promise<string[]>;

export interface SddTask {
  id: string;
  title: string;
  description: string;
  /** Ids of tasks that must finish before this one runs. */
  dependsOn: string[];
  role?: string;
  state: SddTaskState;
  output?: string;
}

export interface TaskGraph {
  tasks: SddTask[];
}

export interface SddSpec {
  id: string;
  brief: string;
  qa: { q: string; a: string }[];
  /** Markdown spec document (human artifact). */
  spec: string;
  graph: TaskGraph;
  createdAt: string;
}

export interface SddRunnerOptions {
  maxQuestions?: number;
  maxTasks?: number;
  /** Max tasks dispatched per ready-wave (default = fleet concurrency). */
  fanout?: number;
  /** Per-task cwd override (e.g. a git worktree). Defaults to the shared cwd. */
  cwdFor?: (taskId: string) => string | undefined;
  /** Supplies a timestamp + id; injectable for tests. Defaults to Date-based. */
  now?: () => string;
}

/**
 * Spec-Driven Development: interview → spec document → task DAG → parallel execution.
 * Reuses the injected fleet runner and the agent's tool-free `plan()` probe. Pause /
 * resume / stop run through a shared {@link RunGate}.
 */
export class SddRunner {
  private readonly gate = new RunGate();
  private readonly maxQuestions: number;
  private readonly maxTasks: number;
  private readonly fanout: number;
  private current?: AbortController;
  private specId = "";

  constructor(
    private readonly agent: Agent,
    private readonly bus: EventBus,
    private readonly runFleet: SddFleetRunner,
    private readonly store: SddStore,
    private readonly opts: SddRunnerOptions = {},
  ) {
    this.maxQuestions = Math.min(8, Math.max(1, opts.maxQuestions ?? 4));
    this.maxTasks = Math.min(40, Math.max(1, opts.maxTasks ?? 12));
    this.fanout = Math.min(16, Math.max(1, opts.fanout ?? 4));
  }

  get state() {
    return this.gate.state;
  }

  /** Full flow: interview (optional) → spec → persist → execute the DAG. */
  async run(brief: string, ask?: SddAsk, signal?: AbortSignal): Promise<SddSpec> {
    this.gate.begin();
    if (signal) signal.addEventListener("abort", () => this.stop(), { once: true });
    this.current = new AbortController();
    if (signal) signal.addEventListener("abort", () => this.current?.abort(), { once: true });

    const questions = ask ? await this.interview(brief) : [];
    const answers = ask && questions.length > 0 ? await ask(questions) : [];
    const qa = questions.map((q, i) => ({ q, a: answers[i] ?? "" }));

    const spec = await this.buildSpec(brief, qa);
    this.specId = spec.id;
    const dir = await this.store.save(spec);
    this.bus.emit({
      type: "sdd_spec",
      id: spec.id,
      specPath: dir,
      taskCount: spec.graph.tasks.length,
    });
    this.bus.emit({
      type: "sdd_graph",
      tasks: spec.graph.tasks.map((t) => ({
        id: t.id,
        title: t.title,
        dependsOn: t.dependsOn,
        state: t.state,
      })),
    });

    if (!this.gate.stopped) await this.execute(spec.graph);
    this.gate.finish();
    return spec;
  }

  /** Generate up to `maxQuestions` short clarifying questions. */
  async interview(brief: string): Promise<string[]> {
    const prompt = `A user wants to build: "${brief}".
Ask up to ${this.maxQuestions} SHORT clarifying questions that would most change the design.
Reply with ONLY a JSON array of strings. If the brief is already clear, reply with [].`;
    const raw = await this.agent.plan(prompt, this.current?.signal);
    const questions = parseStringArray(raw).slice(0, this.maxQuestions);
    this.bus.emit({ type: "sdd_interview", questions });
    return questions;
  }

  /** Produce a markdown spec + a validated task graph from the brief and Q&A. */
  async buildSpec(brief: string, qa: { q: string; a: string }[]): Promise<SddSpec> {
    const qaBlock = qa.length
      ? `\n\nClarifications:\n${qa.map((p) => `Q: ${p.q}\nA: ${p.a}`).join("\n")}`
      : "";
    const roles = availableRoles().join(" | ");
    const prompt = `Write a concise implementation SPEC for: "${brief}".${qaBlock}

First output the spec as markdown. Then output a task graph as a fenced \`\`\`json code block shaped like:
{"tasks":[{"id":"t1","title":"...","description":"...","dependsOn":[],"role":"<optional: ${roles}>"}]}
Keep it to at most ${this.maxTasks} tasks. "dependsOn" lists ids of tasks that must finish first.`;
    const raw = await this.agent.plan(prompt, this.current?.signal);

    const graph = this.validateGraph(parseGraph(raw), brief);
    const id = (this.opts.now ?? defaultNow)();
    const specMd = stripJsonBlock(raw).trim() || `# ${brief}\n\n(no spec text generated)`;
    return { id, brief, qa, spec: specMd, graph, createdAt: id };
  }

  /**
   * Execute the task DAG wave-by-wave: each wave dispatches up to `fanout` ready
   * tasks (all deps done) concurrently through the fleet. Honors pause/stop between
   * waves. Tasks whose deps failed stay blocked; the run ends when nothing is ready.
   */
  async execute(graph: TaskGraph): Promise<void> {
    const byId = new Map(graph.tasks.map((t) => [t.id, t]));
    const done = new Set<string>();
    const failed = new Set<string>();

    while (true) {
      await this.gate.wait();
      if (this.gate.stopped) break;

      const ready = graph.tasks.filter(
        (t) =>
          t.state === "pending" &&
          t.dependsOn.every((d) => done.has(d) || !byId.has(d)) &&
          !t.dependsOn.some((d) => failed.has(d)),
      );
      if (ready.length === 0) break;

      const wave = ready.slice(0, this.fanout);
      for (const t of wave) {
        t.state = "running";
        this.bus.emit({ type: "sdd_task_state", id: t.id, title: t.title, state: "running" });
      }

      this.current = new AbortController();
      let results: AutonomyTaskResult[];
      try {
        results = await this.runFleet(
          wave.map((t) => ({ task: taskPrompt(t), role: t.role })),
          this.current.signal,
        );
      } catch {
        for (const t of wave) {
          t.state = "failed";
          failed.add(t.id);
          this.bus.emit({ type: "sdd_task_state", id: t.id, title: t.title, state: "failed" });
        }
        if (this.gate.stopped) break;
        continue;
      }

      wave.forEach((t, i) => {
        const output = results[i]?.output ?? "";
        const ok = !output.startsWith("sub-agent failed");
        t.state = ok ? "done" : "failed";
        t.output = output;
        (ok ? done : failed).add(t.id);
        this.bus.emit({ type: "sdd_task_state", id: t.id, title: t.title, state: t.state });
      });
    }

    this.bus.emit({ type: "sdd_done", id: this.specId, done: done.size, failed: failed.size });
  }

  /** Drop unknown deps, break cycles, clamp roles, cap task count; non-empty fallback. */
  private validateGraph(graph: TaskGraph, brief: string): TaskGraph {
    const roles = new Set(availableRoles());
    let tasks = graph.tasks.slice(0, this.maxTasks).map((t, i) => ({
      ...t,
      id: t.id?.trim() ? t.id.trim() : `t${i + 1}`,
      state: "pending" as SddTaskState,
    }));
    if (tasks.length === 0) {
      return {
        tasks: [{ id: "t1", title: brief, description: brief, dependsOn: [], state: "pending" }],
      };
    }
    const ids = new Set(tasks.map((t) => t.id));
    tasks = tasks.map((t) => ({
      ...t,
      dependsOn: Array.isArray(t.dependsOn)
        ? t.dependsOn.filter((d) => ids.has(d) && d !== t.id)
        : [],
      role: typeof t.role === "string" && roles.has(t.role) ? t.role : undefined,
    }));
    return { tasks: breakCycles(tasks) };
  }

  pause(): void {
    this.gate.pause();
    this.current?.abort();
  }

  resume(): void {
    this.gate.resume();
  }

  stop(): void {
    this.gate.stop();
    this.current?.abort();
  }
}

function taskPrompt(t: SddTask): string {
  return `${t.title}\n\n${t.description}`;
}

function defaultNow(): string {
  // e.g. 2026-06-29T11-15-03-123Z — filesystem-safe, sortable.
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/** Parse a JSON array of strings, tolerating prose around it. */
export function parseStringArray(raw: string): string[] {
  const match = raw.match(/\[[\s\S]*\]/);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[0]);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((s): s is string => typeof s === "string" && s.trim().length > 0);
  } catch {
    return [];
  }
}

/** Extract a task graph: prefer a ```json fenced block, else the first {...}. */
export function parseGraph(raw: string): TaskGraph {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : raw.match(/\{[\s\S]*\}/)?.[0];
  if (!candidate) return { tasks: [] };
  try {
    const parsed = JSON.parse(candidate) as { tasks?: unknown };
    if (!parsed || !Array.isArray(parsed.tasks)) return { tasks: [] };
    const tasks: SddTask[] = [];
    for (const item of parsed.tasks) {
      if (!item || typeof item !== "object") continue;
      const o = item as Record<string, unknown>;
      if (typeof o.title !== "string" || !o.title.trim()) continue;
      tasks.push({
        id: typeof o.id === "string" ? o.id : "",
        title: o.title.trim(),
        description: typeof o.description === "string" ? o.description : o.title.trim(),
        dependsOn: Array.isArray(o.dependsOn)
          ? o.dependsOn.filter((d): d is string => typeof d === "string")
          : [],
        role: typeof o.role === "string" ? o.role : undefined,
        state: "pending",
      });
    }
    return { tasks };
  } catch {
    return { tasks: [] };
  }
}

/** Remove the first fenced ```json block from text (leaving the markdown spec). */
function stripJsonBlock(raw: string): string {
  return raw.replace(/```(?:json)?\s*[\s\S]*?```/i, "");
}

/** Drop dependency edges that would form a cycle (keeps the graph a DAG). */
function breakCycles(tasks: SddTask[]): SddTask[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const color = new Map<string, 0 | 1 | 2>(); // 0=unvisited,1=in-stack,2=done

  const visit = (id: string): void => {
    color.set(id, 1);
    const t = byId.get(id);
    if (t) {
      t.dependsOn = t.dependsOn.filter((d) => {
        const c = color.get(d) ?? 0;
        if (c === 1) return false; // back-edge → drop to break the cycle
        if (c === 0) visit(d);
        return true;
      });
    }
    color.set(id, 2);
  };

  for (const t of tasks) if ((color.get(t.id) ?? 0) === 0) visit(t.id);
  return tasks;
}
