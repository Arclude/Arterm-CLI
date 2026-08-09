import { Agent, type AgentOptions } from "./agent.js";
import { getAgentDefinition, listAgentDefinitions } from "./agentRegistry.js";
import { AutonomyEngine } from "./autonomy.js";
import type { RunBudget } from "./budget.js";
import { type Chronicle, chronicleToolCall } from "./chronicle.js";
import type { ContextStrategy } from "./contextStrategy.js";
import type { CredentialSettings } from "./credentials.js";
import { type AgentEvent, EventBus } from "./eventBus.js";
import { Container } from "./kernel/container.js";
import { createPipelines } from "./kernel/pipeline.js";
import { RunController } from "./kernel/runController.js";
import { Tokens } from "./kernel/tokens.js";
import type { LoopDetectOptions } from "./loopDetector.js";
import type { PermissionManager } from "./permissions.js";
import type { ProcessRegistry } from "./processRegistry.js";
import type { SandboxRunner } from "./sandbox.js";
import type { ChatProvider, PermissionAsker, Tool } from "./types.js";
import type { WorkspaceWatcher } from "./workspaceWatch.js";
import {
  type WorktreeHandle,
  captureWorktree,
  createWorktree,
  isGitRepo,
  pruneWorktrees,
  removeWorktree,
} from "./worktree.js";

/** Preset sub-agent roles: a role prepends focused instructions to the task. */
const ROLES: Record<string, string> = {
  reviewer:
    "Act as a meticulous code reviewer: inspect the relevant files and report concrete " +
    "issues (bugs, risks, smells) with file:line references.",
  researcher:
    "Act as a researcher: gather and synthesize the information needed, citing the files or " +
    "sources you used.",
  tester:
    "Act as a test engineer: write and/or run tests for the target code and report pass/fail " +
    "with details.",
  implementer: "Act as an implementer: make the focused code change requested, then verify it.",
  explorer: "Act as an explorer: map the relevant part of the codebase and summarize how it works.",
};

/**
 * The instruction prefix for a role, or undefined for an unknown/empty role.
 * User-authored agent definitions (`.arterm/agents/*.md`) take precedence over
 * the built-in role presets.
 */
export function roleInstruction(role?: string): string | undefined {
  if (!role) return undefined;
  return getAgentDefinition(role)?.instruction ?? ROLES[role.toLowerCase()];
}

/** The names of the available sub-agent roles (user definitions ∪ built-ins). */
export function availableRoles(): string[] {
  const defined = listAgentDefinitions().map((d) => d.name.toLowerCase());
  return [...new Set([...defined, ...Object.keys(ROLES)])];
}

export interface SubagentOptions {
  provider: ChatProvider;
  model: string;
  /** Tool set for the sub-agent (should NOT include `spawn` — depth is one level). */
  tools: Tool[];
  permissions: PermissionManager;
  ask: PermissionAsker;
  cwd: string;
  /**
   * The terminal tool the autonomy engine injects to detect completion —
   * `task_done` for work, `submit_verdict` for a review.
   */
  taskDone: Tool;
  context?: ContextStrategy;
  maxSteps?: number;
  /**
   * Tool round-trips per step (Agent default 12). Worth setting for a bounded,
   * short-lived sub-agent: `maxSteps` alone caps *steps*, and each step can burn
   * the full iteration budget, so `maxSteps: 6` is really up to 72 model calls.
   */
  maxIterations?: number;
  /**
   * Per-turn token cap. Without it a configured budget stops at this boundary —
   * a fleet of four would each spend without limit while the parent believed one
   * cap covered the run.
   */
  turnTokenBudget?: number;
  /**
   * Context window and compaction threshold. Only load-bearing for a model the
   * catalog doesn't know (a local GGUF): `effectiveContextWindow()` prefers the
   * catalog, and with neither source a sub-agent never auto-compacts at all.
   */
  contextWindow?: number;
  compactAtPercent?: number;
  /** Loop/stuck detector thresholds — sub-agents loop like leaders do. */
  loopDetect?: LoopDetectOptions;
  /**
   * The run's spend counter. Pass the PARENT's so a fleet's tokens roll up into
   * one ceiling — spawning workers must not be a way to spend more than the run
   * was granted. `RunBudget.child()` is the opt-out for a worker that should be
   * accounted (and capped) separately.
   */
  budget?: RunBudget;
  /**
   * The parent's execution boundary, passed down unchanged. A fleet worker is
   * the same host with more concurrency — sandboxing the main agent while its
   * workers run unconfined would leave the boundary open on the path that
   * actually does the writing under `--autonomous`.
   */
  sandbox?: SandboxRunner;
  /**
   * The parent's env hygiene, passed down unchanged — same argument as the
   * sandbox above, and one more: a worker's output is quoted verbatim into the
   * next wave's prompt, so a key it printed travels further than the parent's.
   */
  credentials?: CredentialSettings;
  /**
   * The parent's process ledger, passed down unchanged — same argument as the
   * sandbox above. A worker that backgrounds a dev server into a registry the
   * session cannot see leaves it running after the session ends.
   */
  processes?: ProcessRegistry;
  /**
   * Stable identity for this worker, used to stamp the ledger — `runFleet`
   * fills it from `FleetTask.id` (team members) or the slot index. Without it a
   * fan-out records three writes by "implementer" and cannot say which worker
   * made which, which is the question a fan-out exists to make hard.
   */
  id?: string;
  role?: string;
  /** Explicit instruction prefix — wins over `roleInstruction(role)` (ad-hoc team members). */
  instruction?: string;
  /** Full system prompt for the sub-agent (a file-backed agent definition's body). */
  systemPrompt?: string;
  /**
   * Observability bridge: receives a whitelisted subset of the sub-agent's private
   * bus events (tool activity, messages — never `text_delta`), so a parent surface
   * (the team board) can watch the member work without flooding its own transcript.
   */
  onEvent?: (event: AgentEvent) => void;
  /**
   * The parent's ledger, passed down unchanged — the same argument as the
   * sandbox, credentials and process registry above, and the sharpest case of
   * it: the WORKERS are where the writing happens. A chronicle that records the
   * leader and not the fleet describes the one agent that mostly reads.
   *
   * The parent's `Chronicle` instance, not a new one, so a fan-out is a single
   * chain: three workers interleaving into three chains could each verify while
   * the run as a whole had no order at all.
   */
  chronicle?: Chronicle;
  /**
   * The tree watcher that makes a worker's SHELL writes visible to that ledger.
   *
   * Optional and separate from `chronicle` on purpose: a run can record what
   * its tools declared without paying to measure what its commands did. One
   * instance is shared with the parent — it resolves a repo root per cwd, so
   * the same object follows a `fleet.isolation: "worktree"` worker into its own
   * tree, which is where the writing a fan-out cares about happens.
   */
  watcher?: WorkspaceWatcher;
}

/**
 * Tools a worker never gets, however it was spawned.
 *
 * Depth is one level by construction: a worker that can spawn is a fan-out
 * with no bound, and nothing above it is counting. This was already enforced
 * by a filter at the call site; it is a named list so the rule is findable
 * from the sub-agent side too.
 */
export const NEVER_SUBAGENT_TOOLS = new Set([
  "spawn",
  "spawn_parallel",
  // The model-driven fleet family. `spawn_subagent` is the one that matters —
  // it creates a worker without a model call, so a worker holding it could
  // build a fleet for free and nothing above would be counting. The rest go
  // with it because a worker that can assign, await or terminate is operating
  // on a fleet it is a member of.
  "spawn_subagent",
  "assign_task",
  "await_tasks",
  "ask_subagent",
  "roll_up",
  "fleet",
]);

/**
 * Tools a worker gets only when its spawn explicitly asks for them.
 *
 * `git_commit` is the case that matters: `--autonomous` clears it under yolo,
 * so today a fleet worker can and does write to git history on its own. The
 * leader is accountable for the run and can commit; a worker that was handed
 * one task in one file has no way to know what else is staged, and its commit
 * lands under the user's name. Hidden by default, grantable by naming it —
 * exactly like the team-member `tools:` frontmatter already works.
 */
export const DEFAULT_HIDDEN_SUBAGENT_TOOLS = new Set(["git_commit"]);

/**
 * The roster a worker should see, given the parent's and an optional explicit
 * allowlist. One function so the /team, /sdd and `spawn` paths cannot drift.
 */
export function subagentRoster<T extends { name: string }>(
  parentTools: T[],
  allow?: string[],
): T[] {
  return parentTools.filter((t) => {
    if (NEVER_SUBAGENT_TOOLS.has(t.name)) return false;
    if (allow) return allow.includes(t.name);
    return !DEFAULT_HIDDEN_SUBAGENT_TOOLS.has(t.name);
  });
}

/** Private-bus event types forwarded through `SubagentOptions.onEvent`. */
const BRIDGED_EVENTS = new Set<AgentEvent["type"]>([
  "tool_call",
  "tool_result",
  "tool_denied",
  "assistant_message",
  "autonomy_step",
  "usage",
  // How full a worker's own context is. Without this the board could show what
  // a member was DOING but not how close it was to the wall it would hit —
  // and a worker at 90% is about to compact or truncate, which is the single
  // most useful thing to know before its output disappoints you.
  "context_usage",
  "error",
  // Why a sub-agent stopped is as much a fact as what it said. Without these a
  // worker that hit its iteration/token cap looked identical to one that
  // finished, and the parent had no way to tell truncation from completion.
  "run_limit",
  "autonomy_stopped",
  "autonomy_done",
  // A stuck worker is as much a fact as a stopped one: the parent board should
  // show "looping" instead of a silent busy row.
  "loop_detected",
  "loop_cut",
]);

/**
 * A sub-agent that OUTLIVES one task.
 *
 * `runSubagent` is this used once, which is all `/team` and `/sdd` ever needed:
 * the engine decides the whole wave up front, so a worker is born, does its one
 * job and is gone. That is also the limitation CLAUDE.md records about `/sdd` —
 * a wave-2 worker is a fresh sub-agent with no memory of wave 1, and the
 * dependency outputs are the only channel between them.
 *
 * A session keeps the `Agent`, so a second task sees the first one's history:
 * the worker that read the parser can be asked what it found without being told
 * again. That is what makes a fleet the MODEL can drive different from one the
 * engine drives — the model does not know wave 2 until wave 1 answers.
 *
 * Tasks on one session must not overlap: two `run()` calls interleaving on one
 * `Agent` would braid two conversations into one history. The caller serialises
 * (see `FleetRegistry`, which gives every worker a queue).
 */
export interface SubagentSession {
  /** The worker's private bus — its tool calls never reach the parent transcript. */
  readonly bus: EventBus;
  readonly agent: Agent;
  /** True between `run()` being called and its promise settling. */
  readonly busy: boolean;
  /** How many tasks this session has completed. */
  readonly completed: number;
  run(
    task: string,
    over?: { instruction?: string; role?: string },
    signal?: AbortSignal,
  ): Promise<string>;
  /** Stop whatever is running now; the session stays usable. */
  stop(): void;
}

/**
 * A container carrying ONLY the ledger stage.
 *
 * Deliberately not the parent's container. Sharing that would hand the worker
 * the parent's `execute` stage too — which closes over the parent's tools and
 * working directory — and the Agent's `has(name)` guard means the worker would
 * silently keep it instead of installing its own. So the worker gets fresh
 * pipelines with one stage pre-registered, and everything else is built for it
 * as usual.
 *
 * Registered before the Agent constructs, which is what puts it ahead of
 * `permission` in the chain: a denied worker call is recorded rather than lost,
 * exactly as it is for the leader.
 */
function subagentContainer(chronicle: Chronicle, opts: SubagentOptions): Container {
  const pipelines = createPipelines();
  pipelines.toolCall.use(
    "chronicle",
    chronicleToolCall(
      chronicle,
      () => opts.cwd,
      // The worker's identity travels with the record: "who changed this file"
      // is the question a fan-out makes hard, and a ledger that answered it
      // with one session id would be no better than the summary it replaces.
      () => ({ agentId: opts.id ?? opts.role ?? "worker" }),
      // The worker's OWN roster, not the parent's: a fleet member is spawned
      // with a narrowed tool set, and a gate consulting the wrong list would
      // measure the tree around calls this worker cannot make.
      opts.watcher ? { watcher: opts.watcher, tools: () => opts.tools } : undefined,
    ),
  );
  const container = new Container();
  container.bind(Tokens.Pipelines, () => pipelines);
  container.bind(Tokens.RunController, () => new RunController(container));
  return container;
}

export function createSubagentSession(opts: SubagentOptions): SubagentSession {
  const bus = new EventBus();
  const agentOpts: AgentOptions = {
    provider: opts.provider,
    model: opts.model,
    tools: opts.tools,
    permissions: opts.permissions,
    ask: opts.ask,
    bus,
    cwd: opts.cwd,
    context: opts.context,
    systemPrompt: opts.systemPrompt,
    ...(opts.maxIterations !== undefined ? { maxIterations: opts.maxIterations } : {}),
    ...(opts.turnTokenBudget !== undefined ? { turnTokenBudget: opts.turnTokenBudget } : {}),
    ...(opts.contextWindow !== undefined ? { contextWindow: opts.contextWindow } : {}),
    ...(opts.compactAtPercent !== undefined ? { compactAtPercent: opts.compactAtPercent } : {}),
    ...(opts.loopDetect !== undefined ? { loopDetect: opts.loopDetect } : {}),
    ...(opts.budget !== undefined ? { budget: opts.budget } : {}),
    ...(opts.sandbox !== undefined ? { sandbox: opts.sandbox } : {}),
    ...(opts.credentials !== undefined ? { credentials: opts.credentials } : {}),
    ...(opts.processes !== undefined ? { processes: opts.processes } : {}),
    ...(opts.chronicle ? { container: subagentContainer(opts.chronicle, opts) } : {}),
  };
  const agent = new Agent(agentOpts);

  // The observability bridge lives for the SESSION, not for one task: a board
  // watching a persistent worker must not go blind between its tasks.
  if (opts.onEvent) {
    bus.on((e) => {
      if (BRIDGED_EVENTS.has(e.type)) opts.onEvent?.(e);
    });
  }

  let current: AutonomyEngine | undefined;
  let completed = 0;
  let busy = false;

  const run = async (
    task: string,
    over?: { instruction?: string; role?: string },
    signal?: AbortSignal,
  ): Promise<string> => {
    let lastAssistant = "";
    let doneSummary: string | undefined;
    let lastError = "";
    let limit: { kind: "iterations" | "tokens"; limit: number } | undefined;
    const off = bus.on((e) => {
      if (e.type === "assistant_message") {
        const text = e.message.content.trim();
        if (text) lastAssistant = text;
      } else if (e.type === "autonomy_done") {
        doneSummary = e.summary;
      } else if (e.type === "run_limit") {
        limit = { kind: e.kind, limit: e.limit };
      } else if (e.type === "error") {
        // The agent loop swallows provider errors into bus events; on this
        // PRIVATE bus nobody else sees them, so keep the last one to surface as
        // the result when the run otherwise produced nothing (e.g. auth/quota).
        lastError = e.error;
      }
    });

    const engine = new AutonomyEngine(agent, bus, opts.taskDone, {
      mode: "once",
      maxSteps: opts.maxSteps ?? 12,
    });
    current = engine;
    busy = true;
    const onAbort = () => engine.stop();
    signal?.addEventListener("abort", onAbort, { once: true });

    // The role preamble is sent ONCE. On a persistent worker it is already in
    // the history, and repeating it per task both costs tokens and reads as a
    // new instruction rather than the standing one.
    const instruction =
      completed === 0
        ? (over?.instruction ?? opts.instruction ?? roleInstruction(over?.role ?? opts.role))
        : undefined;
    const fullTask = instruction ? `${instruction}\n\nTASK: ${task}` : task;
    try {
      await engine.start(fullTask);
    } finally {
      off();
      signal?.removeEventListener("abort", onAbort);
      current = undefined;
      busy = false;
      completed++;
    }
    // A worker that hit a cap in an earlier step and then declared itself done
    // DID finish; only an undeclared result is suspect.
    if (doneSummary) return doneSummary;
    if (lastAssistant) {
      return limit
        ? `[truncated: ${limit.kind} cap ${limit.limit} reached — this result is UNFINISHED]\n${lastAssistant}`
        : lastAssistant;
    }
    // Nothing produced: report WHY instead of a blank shrug — a provider failure
    // (401 quota, unreachable host, …) was previously invisible to the caller.
    return lastError ? `sub-agent failed: ${lastError}` : "(sub-agent produced no output)";
  };

  return {
    bus,
    agent,
    get busy() {
      return busy;
    },
    get completed() {
      return completed;
    },
    run,
    stop: () => current?.stop(),
  };
}

/**
 * Runs a focused sub-agent toward a task with its own history and a private event
 * bus (so its tool calls don't flood the parent transcript), and returns its final
 * output. Uses the autonomy loop in "once" mode bounded by `maxSteps`.
 *
 * One task, one worker — the shape `/team` and `/sdd` dispatch. For a worker
 * that takes more than one task, use `createSubagentSession`.
 */
export async function runSubagent(
  task: string,
  opts: SubagentOptions,
  signal?: AbortSignal,
): Promise<string> {
  return createSubagentSession(opts).run(task, undefined, signal);
}

export interface FleetTask {
  task: string;
  role?: string;
  /** Stable member id (team mode) — lets consumers key events without guessing. */
  id?: string;
  /** Per-task overrides of the fleet-wide sub-agent options (team members). */
  instruction?: string;
  systemPrompt?: string;
  tools?: Tool[];
  isolation?: FleetIsolation;
  onEvent?: (event: AgentEvent) => void;
  /**
   * Asker for THIS task's permission prompts. The fleet shares one asker by
   * default, which leaves a prompt unable to say which worker raised it; a host
   * that cares passes a per-task asker tagged with the worker's identity.
   */
  ask?: PermissionAsker;
}

export interface FleetResult {
  task: string;
  role?: string;
  /** Echoed back from `FleetTask.id` when set. */
  id?: string;
  output: string;
  /** True when the sub-agent threw (its slot holds the error message). */
  error?: boolean;
  /** Present when `isolation: "worktree"` produced changes for this task. */
  worktree?: { branch: string; files: string[]; patch: string };
}

/** How concurrent fleet workers share (or isolate) the filesystem. */
export type FleetIsolation = "none" | "worktree";

export interface FleetOptions extends Omit<SubagentOptions, "role"> {
  /** Max sub-agents running at once (default 4). */
  concurrency?: number;
  /** "none" (default) = shared cwd; "worktree" = each worker gets its own git worktree. */
  isolation?: FleetIsolation;
  onStart?: (index: number, task: string, role?: string) => void;
  onDone?: (index: number, output: string, result?: FleetResult) => void;
  /** Fired when a worker's worktree is created (isolation active + git repo). */
  onWorktree?: (index: number, info: { path: string; branch: string }) => void;
}

/**
 * Runs several sub-agents concurrently (bounded by `concurrency`) and returns
 * their results in input order. A failing sub-agent yields an error string in its
 * slot rather than aborting the whole fleet.
 */
export async function runFleet(
  tasks: FleetTask[],
  opts: FleetOptions,
  signal?: AbortSignal,
): Promise<FleetResult[]> {
  const concurrency = Math.max(1, opts.concurrency ?? 4);
  const results: FleetResult[] = new Array(tasks.length);
  let next = 0;

  // Worktree isolation only applies where requested (fleet-wide or per-task) AND
  // the cwd is a git repo; otherwise workers fall back to the shared cwd. The repo
  // check is resolved once for the whole fleet.
  const wantIsolation =
    opts.isolation === "worktree" || tasks.some((t) => t.isolation === "worktree");
  const repoOk = wantIsolation && (await isGitRepo(opts.cwd, signal));
  const live = new Set<WorktreeHandle>();

  const worker = async (): Promise<void> => {
    while (true) {
      const index = next++;
      if (index >= tasks.length) return;
      const t = tasks[index] as FleetTask;
      opts.onStart?.(index, t.task, t.role);
      // Per-task overrides (team members) win over the fleet-wide options.
      const sub: SubagentOptions = {
        ...opts,
        // Team members bring their own id; a parallel slot is anonymous, so the
        // role and the slot together are what distinguish it in the ledger.
        id: t.id ?? `${t.role ?? "worker"}#${index}`,
        role: t.role,
        instruction: t.instruction ?? opts.instruction,
        systemPrompt: t.systemPrompt ?? opts.systemPrompt,
        tools: t.tools ?? opts.tools,
        onEvent: t.onEvent ?? opts.onEvent,
        ask: t.ask ?? opts.ask,
      };
      const isolate = (t.isolation ?? opts.isolation) === "worktree" && repoOk;
      let output = "";
      let failed = false;
      let worktreeInfo: FleetResult["worktree"];

      if (isolate) {
        let wt: WorktreeHandle | undefined;
        try {
          wt = await createWorktree(opts.cwd, t.id ?? String(index), signal);
          live.add(wt);
          opts.onWorktree?.(index, { path: wt.path, branch: wt.branch });
          output = await runSubagent(t.task, { ...sub, cwd: wt.path }, signal);
        } catch (err) {
          output = `sub-agent failed: ${(err as Error).message}`;
          failed = true;
        } finally {
          if (wt) {
            const changes = await captureWorktree(wt, signal);
            if (changes.changed) {
              worktreeInfo = { branch: wt.branch, files: changes.files, patch: changes.patch };
              output = `${output}\n\n[worktree ${wt.branch}] changed ${changes.files.length} file(s):\n${changes.files.join("\n")}`;
            }
            await removeWorktree(wt, opts.cwd, { keepBranch: changes.changed });
            live.delete(wt);
          }
        }
      } else {
        try {
          output = await runSubagent(t.task, sub, signal);
        } catch (err) {
          output = `sub-agent failed: ${(err as Error).message}`;
          failed = true;
        }
      }

      // A worker that threw OR one whose sub-agent reported a swallowed provider
      // failure (the "sub-agent failed:" convention) counts as failed.
      const errored = failed || output.startsWith("sub-agent failed:");
      const result: FleetResult = {
        task: t.task,
        role: t.role,
        id: t.id,
        output,
        ...(errored ? { error: true } : {}),
        worktree: worktreeInfo,
      };
      results[index] = result;
      opts.onDone?.(index, output, result);
    }
  };

  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker()));
  } finally {
    // Sweep any worktrees still live (abort/throw mid-round) so nothing leaks.
    if (repoOk) {
      for (const wt of live) await removeWorktree(wt, opts.cwd, { keepBranch: false });
      await pruneWorktrees(opts.cwd);
    }
  }
  return results;
}
