import type { Agent } from "./agent.js";
import type { AutonomyTask, AutonomyTaskResult } from "./autonomy.js";
import type { EventBus, SddTaskState } from "./eventBus.js";
import { RunGate } from "./runGate.js";
import type { SddStore } from "./sddStore.js";
import { availableRoles } from "./subagent.js";
import { type Verifier, extractVerifyCommand } from "./verify.js";

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
  /**
   * Character budget for the upstream outputs handed to a dependent task
   * (default 12000, split across its dependencies). 0 disables the handoff.
   */
  handoffChars?: number;
  /**
   * Character budget for the spec document quoted into every task's prompt
   * (default 6000). 0 dispatches tasks without the spec they came from.
   */
  specChars?: number;
  /** Per-task cwd override (e.g. a git worktree). Defaults to the shared cwd. */
  cwdFor?: (taskId: string) => string | undefined;
  /** The tree a declared verification command runs in — the one workers wrote to. */
  cwd?: string;
  /**
   * Result verifier. A task whose output the verifier rejects is `failed`, which
   * blocks its dependents — and those are now reported rather than vanishing.
   */
  verify?: Verifier;
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
  private readonly handoffChars: number;
  private readonly specChars: number;
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
    this.handoffChars = Math.min(200_000, Math.max(0, opts.handoffChars ?? 12_000));
    this.specChars = Math.min(200_000, Math.max(0, opts.specChars ?? 6_000));
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

    if (!this.gate.stopped) await this.execute(spec.graph, spec.spec);
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
Keep it to at most ${this.maxTasks} tasks. "dependsOn" lists ids of tasks that must finish first.
When a shell command can prove a task is done, make the FIRST line of its "description" exactly \`verify: <command>\` — that command then gates the task.`;
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
   *
   * `spec` is the markdown document the graph was cut from. Every worker gets it:
   * it is where the shared decisions live (the approach taken, the names agreed,
   * what was ruled out), and a task description is a sentence, not a design.
   */
  async execute(graph: TaskGraph, spec?: string): Promise<void> {
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
          wave.map((t) => ({
            // The graph's own id, so every event the fleet emits for this worker —
            // its state, its tool calls, a permission prompt it raises — is keyed to
            // the task the board already shows. Without it the fleet mints a
            // synthetic `f<round>-<n>`, and the run looks unplanned to a host that
            // has had the whole DAG since `sdd_graph`.
            id: t.id,
            task: taskPrompt(t, {
              upstream: this.upstream(t, byId),
              handoffChars: this.handoffChars,
              spec: spec ?? "",
              specChars: this.specChars,
            }),
            role: t.role,
          })),
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

      const verified = await Promise.all(
        wave.map(async (t, i) => {
          const r = results[i];
          if (!this.opts.verify || !r || r.error === true) return undefined;
          const res = await this.opts.verify({
            goal: `${t.title}\n\n${t.description}`,
            claim: r.output,
            spec: t.description,
            cwd: this.opts.cwdFor?.(t.id) ?? this.opts.cwd,
            ...(this.current?.signal ? { signal: this.current.signal } : {}),
          });
          this.bus.emit({
            type: "autonomy_verify",
            pass: res.pass,
            ...(res.reason ? { note: res.reason } : {}),
            ...(res.by ? { by: res.by } : {}),
            ...(res.mustFix?.length ? { mustFix: res.mustFix } : {}),
            ...(res.skipped ? { skipped: true } : {}),
            scope: "task",
            id: t.id,
          });
          return res;
        }),
      );

      wave.forEach((t, i) => {
        const r = results[i];
        // Trust the fleet's own flag rather than re-sniffing the output prefix: a
        // patch conflict sets `error` WITHOUT changing the text, so a prefix test
        // scored those as done.
        const gate = verified[i];
        const ok = !!r && r.error !== true && gate?.pass !== false;
        t.state = ok ? "done" : "failed";
        t.output =
          gate?.pass === false
            ? `${r?.output ?? ""}\n\n[verification failed: ${gate.reason ?? "criteria not met"}]`
            : (r?.output ?? "");
        (ok ? done : failed).add(t.id);
        this.bus.emit({ type: "sdd_task_state", id: t.id, title: t.title, state: t.state });
      });
    }

    // The loop exits only when no pending task has all its dependencies done, so
    // everything still pending is permanently unreachable. A user /stop also leaves
    // pending tasks, but those are cancelled rather than blocked — skip the sweep.
    const blocked = this.gate.stopped ? [] : graph.tasks.filter((t) => t.state === "pending");
    for (const t of blocked) {
      t.state = "blocked";
      this.bus.emit({ type: "sdd_task_state", id: t.id, title: t.title, state: "blocked" });
    }

    this.bus.emit({
      type: "sdd_done",
      id: this.specId,
      done: done.size,
      failed: failed.size,
      blocked: blocked.length,
    });
  }

  /**
   * The finished dependencies of `t`, in declared order. A wave-2 worker is a
   * fresh sub-agent with no memory of wave 1, and under worktree isolation it
   * cannot even read the files wave 1 wrote — so these outputs are the only
   * channel between a task and the work it was told to build on.
   */
  private upstream(t: SddTask, byId: Map<string, SddTask>): SddTask[] {
    const out: SddTask[] = [];
    for (const id of t.dependsOn) {
      const dep = byId.get(id);
      if (dep && dep.state === "done" && dep.output?.trim()) out.push(dep);
    }
    return out;
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

/** Floor on each dependency's share, so a wide fan-in can't shrink them to noise. */
const MIN_DEP_CHARS = 600;

/** Everything a worker gets beyond its own title and description. */
interface TaskContext {
  /** Finished dependencies whose output this task builds on. */
  upstream: SddTask[];
  handoffChars: number;
  /** The markdown spec the whole graph was cut from. */
  spec: string;
  specChars: number;
}

function taskPrompt(t: SddTask, ctx: TaskContext): string {
  // Tell the worker how it will be graded. A task that declares a command is
  // only accepted when that command exits 0, so running it first is strictly
  // cheaper than being rejected for it. Keep it last: it is the instruction the
  // worker should read closest to acting, and the context above can be long.
  const cmd = extractVerifyCommand(t.description);
  const gate = cmd
    ? `\n\nThis task is only accepted when \`${cmd}\` exits 0. Run it yourself before you finish.`
    : "";
  const spec = specBlock(ctx.spec, ctx.specChars);
  const upstream = handoff(ctx.upstream, ctx.handoffChars);
  return `${t.title}\n\n${t.description}${spec}${upstream}${gate}`;
}

/**
 * Quote the shared spec. The scope sentence is load-bearing: handing a worker the
 * whole design invites it to implement the whole design, and two workers doing the
 * same section concurrently is worse than either doing it alone.
 */
function specBlock(spec: string, budget: number): string {
  const text = spec.trim();
  if (!text || budget <= 0) return "";
  return `\n\n## The spec this task comes from

Shared design for the whole run — the decisions, names, and constraints every
task in it follows. Other tasks cover the rest of it and are running right now,
so implement ONLY the task above; use the spec to stay consistent with them.

${clip(text, budget)}`;
}

/** Quote the dependencies' outputs, sharing `budget` characters evenly among them. */
function handoff(deps: SddTask[], budget: number): string {
  if (deps.length === 0 || budget <= 0) return "";
  const per = Math.max(MIN_DEP_CHARS, Math.floor(budget / deps.length));
  const blocks = deps.map((d) => `### ${d.id} — ${d.title}\n\n${clip(d.output ?? "", per)}`);
  return `\n\n## Results of the tasks you depend on

These ran before you and are already done. What they report below is the only
record of their work — do not redo it, and do not assume anything they did not
say. Build on it.

${blocks.join("\n\n")}`;
}

/**
 * Trim to `max` characters keeping both ends: a report's setup is at the top and
 * its conclusion at the bottom, and dropping either end is what makes a handoff
 * useless. The middle is the safest thing to lose.
 */
function clip(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  const head = Math.floor(max * 0.6);
  const tail = max - head;
  return `${t.slice(0, head)}\n\n… (${t.length - max} characters omitted from the middle) …\n\n${t.slice(-tail)}`;
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
