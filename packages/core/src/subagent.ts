import { Agent, type AgentOptions } from "./agent.js";
import { AutonomyEngine } from "./autonomy.js";
import type { ContextStrategy } from "./contextStrategy.js";
import { EventBus } from "./eventBus.js";
import type { PermissionManager } from "./permissions.js";
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

/** The instruction prefix for a role, or undefined for an unknown/empty role. */
export function roleInstruction(role?: string): string | undefined {
  if (!role) return undefined;
  return ROLES[role.toLowerCase()];
}

/** The names of the available sub-agent roles. */
export function availableRoles(): string[] {
  return Object.keys(ROLES);
}

export interface SubagentOptions {
  provider: ChatProvider;
  model: string;
  /** Tool set for the sub-agent (should NOT include `spawn` — depth is one level). */
  tools: Tool[];
  permissions: PermissionManager;
  ask: PermissionAsker;
  cwd: string;
  /** The `task_done` tool the autonomy engine injects to detect completion. */
  taskDone: Tool;
  context?: ContextStrategy;
  maxSteps?: number;
  role?: string;
}

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
  };
  const agent = new Agent(agentOpts);

  let lastAssistant = "";
  let doneSummary: string | undefined;
  const off = bus.on((e) => {
    if (e.type === "assistant_message") {
      const text = e.message.content.trim();
      if (text) lastAssistant = text;
    } else if (e.type === "autonomy_done") {
      doneSummary = e.summary;
    }
  });

  const engine = new AutonomyEngine(agent, bus, opts.taskDone, {
    mode: "once",
    maxSteps: opts.maxSteps ?? 12,
  });
  if (signal) signal.addEventListener("abort", () => engine.stop(), { once: true });

  const instruction = roleInstruction(opts.role);
  const fullTask = instruction ? `${instruction}\n\nTASK: ${task}` : task;
  try {
    await engine.start(fullTask);
  } finally {
    off();
  }
  return doneSummary || lastAssistant || "(sub-agent produced no output)";
}

export interface FleetTask {
  task: string;
  role?: string;
}

export interface FleetResult {
  task: string;
  role?: string;
  output: string;
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
  onDone?: (index: number, output: string) => void;
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

  // Worktree isolation only applies when requested AND the cwd is a git repo;
  // otherwise we fall back to the shared cwd. `repoRoot` is resolved once.
  const wantIsolation = opts.isolation === "worktree";
  const isolate = wantIsolation && (await isGitRepo(opts.cwd, signal));
  const live = new Set<WorktreeHandle>();

  const worker = async (): Promise<void> => {
    while (true) {
      const index = next++;
      if (index >= tasks.length) return;
      const t = tasks[index] as FleetTask;
      opts.onStart?.(index, t.task, t.role);
      let output = "";
      let worktreeInfo: FleetResult["worktree"];

      if (isolate) {
        let wt: WorktreeHandle | undefined;
        try {
          wt = await createWorktree(opts.cwd, String(index), signal);
          live.add(wt);
          opts.onWorktree?.(index, { path: wt.path, branch: wt.branch });
          output = await runSubagent(t.task, { ...opts, cwd: wt.path, role: t.role }, signal);
        } catch (err) {
          output = `sub-agent failed: ${(err as Error).message}`;
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
          output = await runSubagent(t.task, { ...opts, role: t.role }, signal);
        } catch (err) {
          output = `sub-agent failed: ${(err as Error).message}`;
        }
      }

      opts.onDone?.(index, output);
      results[index] = { task: t.task, role: t.role, output, worktree: worktreeInfo };
    }
  };

  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker()));
  } finally {
    // Sweep any worktrees still live (abort/throw mid-round) so nothing leaks.
    if (isolate) {
      for (const wt of live) await removeWorktree(wt, opts.cwd, { keepBranch: false });
      await pruneWorktrees(opts.cwd);
    }
  }
  return results;
}
