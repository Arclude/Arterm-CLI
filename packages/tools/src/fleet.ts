import type { FleetRegistry, FleetTaskRecord, Tool } from "@arterm/core";
import { optionalString, requireString } from "./paths.js";

/** Result characters shown inline before the model is pointed at the id instead. */
const INLINE_RESULT = 2_000;

/** Summarises several results in one model call, without them passing through the leader. */
export type RollUpFn = (
  parts: Array<{ label: string; text: string }>,
  focus?: string,
) => Promise<string>;

export interface FleetToolOptions {
  registry: FleetRegistry;
  /** Injected so `tools` does not need to know how a model call is made. */
  rollUp?: RollUpFn;
}

function clip(text: string, max = INLINE_RESULT): { text: string; clipped: boolean } {
  if (text.length <= max) return { text, clipped: false };
  return { text: `${text.slice(0, max)}\n… (clipped)`, clipped: true };
}

/** One task rendered for the model: state, timing, and as much result as fits. */
function renderTask(t: FleetTaskRecord, full = false): string {
  const head = `${t.id} [${t.state}] worker=${t.workerId}`;
  if (t.state === "queued" || t.state === "running") {
    const since = t.startedAt ? ` for ${Math.round((Date.now() - t.startedAt) / 1000)}s` : "";
    return `${head}${since}: ${t.task.slice(0, 120)}`;
  }
  const body = t.result ?? "(no output)";
  const shown = full ? { text: body, clipped: false } : clip(body);
  const where = t.resultPath ? `\n[full output: ${t.resultPath}]` : "";
  const more =
    shown.clipped && !t.resultPath ? `\n[clipped — ask for ${t.id} alone to see it all]` : "";
  return `${head}\n${shown.text}${where}${more}`;
}

/**
 * `spawn_subagent` — create a worker without giving it anything to do.
 *
 * The separation from `assign_task` is the point: no model call happens here,
 * so setting up a fleet costs nothing and the model can decide what each worker
 * is for after it has seen the shape of the problem.
 */
export function createSpawnSubagentTool(opts: FleetToolOptions): Tool {
  return {
    name: "spawn_subagent",
    description:
      "Create a persistent sub-agent and return its id, WITHOUT running anything. Give it work " +
      "with assign_task.",
    usageHint:
      "A worker created here keeps its history across tasks, so a follow-up can refer to what it " +
      "already read — that is the difference from `spawn`, which is one task and one blocking " +
      "wait. Give it a `brief` describing its standing job (the area it owns, the conventions to " +
      "follow); give `assign_task` the specific piece. Restrict `tools` when a worker only needs " +
      "to read: a worker with fewer tools makes fewer wrong turns.",
    permission: "ask",
    category: "execute",
    mutating: true,
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Short name for the worker, e.g. 'parser'." },
        role: {
          type: "string",
          description: "reviewer | researcher | tester | implementer | explorer.",
        },
        brief: { type: "string", description: "Standing context for everything it is asked." },
        tools: {
          type: "array",
          items: { type: "string" },
          description: "Restrict the worker to these tool names.",
        },
      },
      required: ["name"],
    },
    preview: (args) =>
      `spawn worker "${String(args.name)}"${args.role ? ` (${String(args.role)})` : ""}`,
    async execute(args) {
      try {
        const worker = opts.registry.spawn({
          name: requireString(args, "name"),
          ...(optionalString(args, "role") !== undefined
            ? { role: optionalString(args, "role") }
            : {}),
          ...(optionalString(args, "brief") !== undefined
            ? { brief: optionalString(args, "brief") }
            : {}),
          ...(Array.isArray(args.tools) ? { tools: args.tools.map(String) } : {}),
        });
        return {
          output: `worker ${worker.id} "${worker.name}" is ready. Give it work with assign_task.`,
        };
      } catch (err) {
        return { output: (err as Error).message, isError: true };
      }
    },
  };
}

/** `assign_task` — hand a worker a task and return at once. */
export function createAssignTaskTool(opts: FleetToolOptions): Tool {
  return {
    name: "assign_task",
    description:
      "Give a worker a task and return IMMEDIATELY with a task id. The worker runs in the " +
      "background; collect it with await_tasks.",
    usageHint:
      "Assign every independent piece before awaiting any of them — assigning and then awaiting " +
      "one at a time is `spawn` with extra steps and no concurrency. A worker runs its own tasks " +
      "in order, so two tasks for one worker are sequential; two workers are parallel.",
    permission: "ask",
    category: "execute",
    mutating: true,
    parameters: {
      type: "object",
      properties: {
        worker: { type: "string", description: "Worker id from spawn_subagent." },
        task: { type: "string", description: "What the worker should do." },
      },
      required: ["worker", "task"],
    },
    preview: (args) => `assign to ${String(args.worker)}: ${String(args.task ?? "").slice(0, 60)}`,
    async execute(args) {
      try {
        const record = opts.registry.assign(
          requireString(args, "worker"),
          requireString(args, "task"),
        );
        return {
          output: `task ${record.id} queued on ${record.workerId}. It is running now — do other work, then await_tasks.`,
        };
      } catch (err) {
        return { output: (err as Error).message, isError: true };
      }
    },
  };
}

/** `await_tasks` — block until assigned work settles. */
export function createAwaitTasksTool(opts: FleetToolOptions): Tool {
  return {
    name: "await_tasks",
    description:
      "Wait for assigned tasks and return their results. Omit `tasks` to wait for everything " +
      "outstanding; use mode 'any' to act on the first one that finishes.",
    usageHint:
      "'any' with a timeout is what turns a fleet into a pipeline: take the first result, give " +
      "that worker its next task, and await again while the rest are still going. A timeout " +
      "returns what HAS finished rather than failing — the others keep running and their ids " +
      "stay collectable, so a short timeout is a way to check in, not a way to give up.",
    permission: "allow",
    category: "read",
    parameters: {
      type: "object",
      properties: {
        tasks: {
          type: "array",
          items: { type: "string" },
          description: "Task ids to wait for; omit for all outstanding.",
        },
        mode: {
          type: "string",
          enum: ["all", "any"],
          description: "Return when all have finished, or after the first (default 'all').",
        },
        timeout_ms: { type: "number", description: "Give up waiting after this long." },
      },
    },
    preview: (args) => {
      const n = Array.isArray(args.tasks) ? args.tasks.length : 0;
      return `await ${n > 0 ? `${n} task(s)` : "all outstanding tasks"} (${String(args.mode ?? "all")})`;
    },
    async execute(args) {
      const ids = Array.isArray(args.tasks) ? args.tasks.map(String) : undefined;
      const mode = args.mode === "any" ? "any" : "all";
      const timeoutMs = typeof args.timeout_ms === "number" ? args.timeout_ms : undefined;
      const { settled, pending, timedOut } = await opts.registry.awaitTasks({
        ...(ids ? { taskIds: ids } : {}),
        mode,
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      });

      if (settled.length === 0 && pending.length === 0) {
        return { output: "No outstanding tasks." };
      }
      const single = settled.length === 1 && pending.length === 0;
      const body = settled.map((t) => renderTask(t, single)).join("\n\n");
      const still =
        pending.length > 0
          ? `\n\n[still running: ${pending.map((t) => t.id).join(", ")}${timedOut ? " — the wait timed out, they are not lost" : ""}]`
          : "";
      return { output: `${body || "(nothing finished yet)"}${still}` };
    },
  };
}

/** `ask_subagent` — a question answered from a worker's own context. */
export function createAskSubagentTool(opts: FleetToolOptions): Tool {
  return {
    name: "ask_subagent",
    description:
      "Ask a worker a question and wait for its answer. The worker answers from what it has " +
      "already seen, so this is cheap compared to re-reading the same files yourself.",
    usageHint:
      "Questions queue behind whatever the worker is doing — a worker has one conversation and " +
      "two at once would braid them. If it is busy, either wait or ask a different worker. Use " +
      "this for 'what did you find', not for work; work is assign_task.",
    permission: "ask",
    category: "execute",
    mutating: true,
    parameters: {
      type: "object",
      properties: {
        worker: { type: "string", description: "Worker id." },
        question: { type: "string", description: "The question." },
        timeout_ms: { type: "number", description: "Give up waiting after this long." },
      },
      required: ["worker", "question"],
    },
    preview: (args) => `ask ${String(args.worker)}: ${String(args.question ?? "").slice(0, 60)}`,
    async execute(args) {
      const question = requireString(args, "question");
      try {
        const record = opts.registry.assign(
          requireString(args, "worker"),
          `Answer this question from what you already know. Do not start new work.\n\n${question}`,
        );
        const timeoutMs = typeof args.timeout_ms === "number" ? args.timeout_ms : 120_000;
        const { settled } = await opts.registry.awaitTasks({
          taskIds: [record.id],
          mode: "all",
          timeoutMs,
        });
        const answered = settled[0];
        if (!answered) {
          return {
            output: `${record.workerId} has not answered within ${timeoutMs}ms — it was busy. The question is queued as ${record.id}; collect it with await_tasks.`,
          };
        }
        return { output: renderTask(answered, true) };
      } catch (err) {
        return { output: (err as Error).message, isError: true };
      }
    },
  };
}

/** `roll_up` — combine several results without routing them through the leader. */
export function createRollUpTool(opts: FleetToolOptions): Tool {
  return {
    name: "roll_up",
    description:
      "Summarise several finished tasks into one answer. The full results are read on the way, " +
      "but only the summary enters this conversation.",
    usageHint:
      "This is what makes a wide fan-out affordable: five workers returning 20 KB each cost you " +
      "a summary rather than 100 KB of window. Give `focus` when you want the summary shaped to " +
      "a question — 'which of these actually changed behaviour' beats a neutral digest.",
    permission: "allow",
    category: "read",
    parameters: {
      type: "object",
      properties: {
        tasks: {
          type: "array",
          items: { type: "string" },
          description: "Task ids to combine; omit for every finished task.",
        },
        focus: { type: "string", description: "What the summary should be about." },
      },
    },
    preview: (args) =>
      `roll up ${Array.isArray(args.tasks) ? args.tasks.length : "all"} task result(s)`,
    async execute(args) {
      const ids = Array.isArray(args.tasks) ? args.tasks.map(String) : undefined;
      const all = opts.registry.listTasks().filter((t) => t.state === "done" && t.result);
      const chosen = ids ? all.filter((t) => ids.includes(t.id)) : all;
      if (chosen.length === 0) {
        return { output: "No finished task results to roll up.", isError: true };
      }
      const parts = chosen.map((t) => ({
        label: `${t.id} (${t.workerId}): ${t.task.slice(0, 120)}`,
        text: t.result ?? "",
      }));
      if (!opts.rollUp) {
        // No summariser wired: hand back the labelled results rather than
        // pretending. Losing the size saving is better than losing the content.
        return {
          output: parts.map((p) => `### ${p.label}\n${clip(p.text).text}`).join("\n\n"),
        };
      }
      try {
        const summary = await opts.rollUp(parts, optionalString(args, "focus"));
        return {
          output: `${summary}\n\n[rolled up ${chosen.length} task(s): ${chosen.map((t) => t.id).join(", ")}]`,
        };
      } catch (err) {
        return { output: `roll_up failed: ${(err as Error).message}`, isError: true };
      }
    },
  };
}

/** `fleet` — the state of the fleet, and the two ways to shut part of it down. */
export function createFleetTool(opts: FleetToolOptions): Tool {
  return {
    name: "fleet",
    description:
      "Show the fleet's workers and tasks, or terminate a worker. Actions: status | terminate | " +
      "terminate_all.",
    permission: "ask",
    category: "execute",
    mutating: true,
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["status", "terminate", "terminate_all"],
          description: "What to do (default 'status').",
        },
        worker: { type: "string", description: "Worker id, for 'terminate'." },
      },
    },
    preview: (args) =>
      `fleet ${String(args.action ?? "status")}${args.worker ? ` ${String(args.worker)}` : ""}`,
    async execute(args) {
      const action = optionalString(args, "action") ?? "status";
      if (action === "terminate") {
        const id = requireString(args, "worker");
        const worker = opts.registry.terminate(id);
        if (!worker) return { output: `no such worker: ${id}`, isError: true };
        return { output: `worker ${id} terminated; its queued tasks were cancelled.` };
      }
      if (action === "terminate_all") {
        const n = opts.registry.terminateAll();
        return { output: n === 0 ? "No live workers." : `Terminated ${n} worker(s).` };
      }

      const workers = opts.registry.listWorkers();
      if (workers.length === 0) return { output: "No workers. Create one with spawn_subagent." };
      const tasks = opts.registry.listTasks();
      const lines = workers.map((w) => {
        const mine = tasks.filter((t) => t.workerId === w.id);
        const running = mine.filter((t) => t.state === "running" || t.state === "queued");
        const done = mine.filter((t) => t.state === "done").length;
        const failed = mine.filter((t) => t.state === "failed").length;
        const busy = running.length > 0 ? ` · running ${running.map((t) => t.id).join(",")}` : "";
        return `${w.id} "${w.name}"${w.role ? ` (${w.role})` : ""} [${w.state}] · done ${done}${
          failed > 0 ? ` · failed ${failed}` : ""
        }${busy}`;
      });
      const outstanding = tasks.filter((t) => t.state === "queued" || t.state === "running");
      const collectable = tasks.filter((t) => t.state === "done" || t.state === "failed");
      return {
        output: [
          ...lines,
          `[${workers.length} worker(s) · ${outstanding.length} outstanding · ${collectable.length} collectable]`,
        ].join("\n"),
      };
    },
  };
}

/** Every model-driven fleet tool, in the order a session should register them. */
export function createFleetTools(opts: FleetToolOptions): Tool[] {
  return [
    createSpawnSubagentTool(opts),
    createAssignTaskTool(opts),
    createAwaitTasksTool(opts),
    createAskSubagentTool(opts),
    createRollUpTool(opts),
    createFleetTool(opts),
  ];
}

/** Tool names in this family — a worker must never receive any of them. */
export const FLEET_TOOL_NAMES = [
  "spawn_subagent",
  "assign_task",
  "await_tasks",
  "ask_subagent",
  "roll_up",
  "fleet",
] as const;
