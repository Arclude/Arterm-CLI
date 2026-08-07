import { type TodoItem, type TodoStore, type Tool, formatTodos } from "@arterm/core";

/**
 * The `todo` tool: the model's own work list, replaced wholesale on every call.
 *
 * `permission: "allow"` and `mutating: false` are correct rather than lax — the
 * call changes the run's own bookkeeping and touches nothing outside the
 * process. Asking a human to approve "I intend to do these four things" would
 * make the list expensive enough that the model stops keeping one, which is
 * the failure this is here to fix.
 */
export function createTodoTool(store: TodoStore): Tool {
  return {
    name: "todo",
    description:
      "Track the steps of a multi-step task. The list is REPLACED on every call — send the " +
      "whole list every time. At most one item may be in_progress. An empty list means done.",
    usageHint:
      "Write the list at the START of anything non-trivial, then update it as you go: mark an " +
      "item in_progress before you begin it and done when it is finished, in the same call. " +
      "Re-order freely — the list is replaced, so order is entirely yours. Keep it honest: the " +
      "user reads this too, and it is the only part of your plan that survives compaction.",
    permission: "allow",
    category: "read",
    mutating: false,
    parameters: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          description: "The complete list, in the order you intend to work through it.",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Stable identifier, e.g. '1' or 'auth-flow'." },
              text: { type: "string", description: "What will be done." },
              status: {
                type: "string",
                enum: ["pending", "in_progress", "done"],
                description: "At most one item may be in_progress.",
              },
            },
            required: ["id", "text", "status"],
          },
        },
      },
      required: ["todos"],
    },
    preview: (args) => {
      const todos = Array.isArray(args.todos) ? args.todos : [];
      return `todo (${todos.length} item${todos.length === 1 ? "" : "s"})`;
    },
    async execute(args) {
      if (!Array.isArray(args.todos)) {
        return { output: "todos must be an array (send the whole list).", isError: true };
      }
      const items: TodoItem[] = [];
      for (const raw of args.todos) {
        const t = raw as Partial<TodoItem>;
        const status = t.status ?? "pending";
        if (status !== "pending" && status !== "in_progress" && status !== "done") {
          return {
            output: `unknown status "${String(status)}" — use pending, in_progress or done.`,
            isError: true,
          };
        }
        items.push({ id: String(t.id ?? ""), text: String(t.text ?? ""), status });
      }

      const result = store.replace(items);
      if (!result.ok) return { output: result.error ?? "todo rejected", isError: true };

      const done = items.filter((i) => i.status === "done").length;
      // The list is echoed back, not just counted: the model's next turn may be
      // on the far side of a compaction, and this result is what it will see.
      return {
        output:
          items.length === 0
            ? "todo list cleared."
            : `${done}/${items.length} done\n${formatTodos(items)}`,
      };
    },
  };
}
