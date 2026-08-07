import type { SddTask, SddTaskState, TaskStore, Tool } from "@arterm/core";

const STATES: SddTaskState[] = ["pending", "running", "done", "failed", "blocked"];

/** One line per task: state, id, title, and what it is waiting on. */
function format(tasks: SddTask[]): string {
  if (tasks.length === 0) return "(no tasks)";
  const mark: Record<SddTaskState, string> = {
    pending: "·",
    running: "▸",
    done: "✓",
    failed: "✗",
    blocked: "⊘",
  };
  return tasks
    .map((t) => {
      const after = t.dependsOn.length > 0 ? `  (after ${t.dependsOn.join(", ")})` : "";
      return `${mark[t.state]} ${t.id}: ${t.title}${after}`;
    })
    .join("\n");
}

/**
 * The `task` tool: a dependency graph the model writes, on the shape `/sdd`
 * executes.
 *
 * `ready` is the reason this is not a second todo list — it answers "what can
 * start now, in parallel", which a flat list cannot. The rest of the actions
 * exist to keep that answer true.
 */
export function createTaskTool(store: TaskStore): Tool {
  return {
    name: "task",
    description:
      "A dependency graph of work items. `set` writes the graph, `state` moves one task, " +
      "`ready` lists what can start now (all dependencies done). Use `todo` for a simple " +
      "ordered checklist — this is for work with real dependencies.",
    usageHint:
      "Write the graph once, then drive it: call `ready` to see what can start, mark a task " +
      "running before you begin and done when it finishes. Dependencies are only worth " +
      "declaring where they are real — a chain of tasks each depending on the last is a list, " +
      "and `todo` is cheaper. A task whose dependency FAILED never becomes ready; that is " +
      "deliberate, and `state: blocked` is how you say so explicitly.",
    permission: "allow",
    category: "edit",
    mutating: true,
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "set", "state", "ready"],
          description: "list (default), set, state, or ready.",
        },
        tasks: {
          type: "array",
          description: "The whole graph, for `set`.",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              title: { type: "string" },
              description: { type: "string" },
              dependsOn: {
                type: "array",
                items: { type: "string" },
                description: "Ids that must be done before this one starts.",
              },
              role: { type: "string", description: "Optional sub-agent role for this task." },
            },
            required: ["id", "title"],
          },
        },
        id: { type: "string", description: "Task to move, for `state`." },
        state: {
          type: "string",
          enum: STATES,
          description: "pending | running | done | failed | blocked.",
        },
        output: { type: "string", description: "What the task produced, for `state`." },
      },
    },
    preview: (args) => `task ${String(args.action ?? "list")}`,
    async execute(args) {
      const action = typeof args.action === "string" ? args.action : "list";

      if (action === "list") return { output: format(store.list()) };

      if (action === "ready") {
        const ready = store.ready();
        const blocked = store.blocked();
        // Blocked tasks are reported alongside, because "nothing is ready" and
        // "nothing can ever be ready" are different situations and only one of
        // them is worth waiting through.
        const note =
          blocked.length > 0 ? `\n\nblocked by a failed dependency:\n${format(blocked)}` : "";
        return { output: `${format(ready)}${note}` };
      }

      if (action === "set") {
        if (!Array.isArray(args.tasks)) {
          return { output: "`set` needs a tasks array.", isError: true };
        }
        const tasks: SddTask[] = args.tasks.map((raw) => {
          const t = raw as Partial<SddTask>;
          return {
            id: String(t.id ?? ""),
            title: String(t.title ?? ""),
            description: String(t.description ?? t.title ?? ""),
            dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn.map(String) : [],
            state: (STATES as string[]).includes(String(t.state))
              ? (t.state as SddTaskState)
              : "pending",
            ...(t.role ? { role: String(t.role) } : {}),
          };
        });
        const result = await store.replace(tasks);
        if (!result.ok) return { output: result.error ?? "graph rejected", isError: true };
        return { output: `${tasks.length} task(s)\n${format(result.tasks)}` };
      }

      if (action === "state") {
        const id = typeof args.id === "string" ? args.id : "";
        const state = String(args.state ?? "");
        if (!id) return { output: "`state` needs an id.", isError: true };
        if (!(STATES as string[]).includes(state)) {
          return { output: `unknown state "${state}" — use ${STATES.join(", ")}.`, isError: true };
        }
        const result = await store.setState(
          id,
          state as SddTaskState,
          typeof args.output === "string" ? args.output : undefined,
        );
        if (!result.ok) return { output: result.error ?? "not updated", isError: true };
        const ready = store.ready();
        // What this unblocked, said at the moment it becomes true — otherwise
        // the model has to ask, and usually does not.
        const next = ready.length > 0 ? `\nready now:\n${format(ready)}` : "";
        return { output: `${id} → ${state}${next}` };
      }

      return {
        output: `unknown action "${action}" — use list, set, state or ready.`,
        isError: true,
      };
    },
  };
}
