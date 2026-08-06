import { Agent, type AgentOptions } from "./agent.js";
import { getAgentDefinition, listAgentDefinitions } from "./agentRegistry.js";
import { AutonomyEngine } from "./autonomy.js";
import type { RunBudget } from "./budget.js";
import type { ContextStrategy } from "./contextStrategy.js";
import { type AgentEvent, EventBus } from "./eventBus.js";
import type { LoopDetectOptions } from "./loopDetector.js";
import type { PermissionManager } from "./permissions.js";
import type { SandboxRunner } from "./sandbox.js";
import type { ChatProvider, PermissionAsker, Tool } from "./types.js";
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
}

/** Private-bus event types forwarded through `SubagentOptions.onEvent`. */
const BRIDGED_EVENTS = new Set<AgentEvent["type"]>([
  "tool_call",
  "tool_result",
  "tool_denied",
  "assistant_message",
  "autonomy_step",
  "usage",
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
 * Runs a focused sub-agent toward a task with its own history and a private event
 * bus (so its tool calls don't flood the parent transcript), and returns its final
 * output. Uses the autonomy loop in "once" mode bounded by `maxSteps`.
 */
export async function runSubagent(
  task: string,
  opts: SubagentOptions,
  signal?: AbortSignal,
): Promise<string> {
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
  };
  const agent = new Agent(agentOpts);

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
      // The agent loop swallows provider errors into bus events; on this PRIVATE
      // bus nobody else sees them, so keep the last one to surface as the result
      // when the run otherwise produced nothing (e.g. auth/quota failures).
      lastError = e.error;
    }
    if (opts.onEvent && BRIDGED_EVENTS.has(e.type)) opts.onEvent(e);
  });

  const engine = new AutonomyEngine(agent, bus, opts.taskDone, {
    mode: "once",
    maxSteps: opts.maxSteps ?? 12,
  });
  if (signal) signal.addEventListener("abort", () => engine.stop(), { once: true });

  const instruction = opts.instruction ?? roleInstruction(opts.role);
  const fullTask = instruction ? `${instruction}\n\nTASK: ${task}` : task;
  try {
    await engine.start(fullTask);
  } finally {
    off();
  }
  // A worker that hit a cap in an earlier step and then declared itself done DID
  // finish; only an undeclared result is suspect.
  if (doneSummary) return doneSummary;
  if (lastAssistant) {
    return limit
      ? `[truncated: ${limit.kind} cap ${limit.limit} reached — this result is UNFINISHED]\n${lastAssistant}`
      : lastAssistant;
  }
  // Nothing produced: report WHY instead of a blank shrug — a provider failure
  // (401 quota, unreachable host, …) was previously invisible to the caller.
  return lastError ? `sub-agent failed: ${lastError}` : "(sub-agent produced no output)";
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
