import { type PlanStore, type Tool, planAge } from "@arterm/core";

/**
 * The `plan` tool: the strategy above the steps, written to disk.
 *
 * Three actions and no more. `set` replaces (a merge into a plan the model
 * half-remembers is the failure mode), `get` returns what is stored with its
 * AGE — a plan whose age is invisible gets treated as current forever — and
 * `clear` ends it.
 *
 * `permission: "allow"` for the same reason as `todo`: this writes the run's
 * own notes into the agent's own directory, not into the user's project. It is
 * `mutating: true` because it does touch a file, which is what the permission
 * inspector should report.
 */
export function createPlanTool(store: PlanStore): Tool {
  return {
    name: "plan",
    description:
      "Record or read the strategy for this session's work — what is being done and why. " +
      "Survives context compaction and /clear. Use `todo` for the step list.",
    usageHint:
      "Write a plan once you know the SHAPE of the work: the goal, the approach, what you " +
      "decided against and why, and what would make this done. Re-read it (action: 'get') " +
      "after a compaction or when you are unsure what you were doing — that is what it is for. " +
      "Keep it short enough to re-read: it is a compass, not a report.",
    permission: "allow",
    category: "edit",
    mutating: true,
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["get", "set", "clear"],
          description: "get (default), set, or clear.",
        },
        title: { type: "string", description: "One line: what this work is (for `set`)." },
        body: {
          type: "string",
          description: "The strategy: approach, rejected alternatives, definition of done.",
        },
      },
    },
    preview: (args) => `plan ${String(args.action ?? "get")}`,
    async execute(args) {
      const action = typeof args.action === "string" ? args.action : "get";

      if (action === "clear") {
        await store.clear();
        return { output: "plan cleared." };
      }

      if (action === "set") {
        const title = typeof args.title === "string" ? args.title.trim() : "";
        const body = typeof args.body === "string" ? args.body.trim() : "";
        if (!title || !body) {
          return { output: "`set` needs both a title and a body.", isError: true };
        }
        const doc = await store.set(title, body);
        return { output: `plan saved: ${doc.title}` };
      }

      if (action !== "get") {
        return { output: `unknown action "${action}" — use get, set or clear.`, isError: true };
      }

      const doc = await store.get();
      if (!doc) return { output: "(no plan for this session yet)" };
      // The age is part of the answer, not a footnote: a plan written an hour
      // and three pivots ago should be read differently from one written now.
      return { output: `${doc.title}  (written ${planAge(doc.updatedAt)})\n\n${doc.body}` };
    },
  };
}
