/**
 * The model's own work list.
 *
 * A long run's plan lived in exactly one place before this: the conversation.
 * Which means it was re-stated in prose every few turns, drifted every time it
 * was re-stated, and disappeared entirely at the first compaction — the run
 * kept going with no memory of what it had set out to do. Compaction is not a
 * rare event: it fires at 75% of the window, and an eternal run crosses that
 * repeatedly.
 *
 * So the list lives OUTSIDE the conversation. It survives compaction, `/clear`
 * does not touch it, and both the model and the user read the same copy.
 *
 * The contract is deliberately blunt, and it is the one WrongStack settled on:
 *
 * - **The list is REPLACED on every call**, never appended to. Incremental
 *   updates require the model to track ids it invented several turns ago and
 *   get them right; it does not, and a half-applied update to a plan is worse
 *   than no plan. Sending the whole list makes every write idempotent and
 *   makes re-ordering free.
 * - **At most one item is `in_progress`.** Not a style rule: two things in
 *   progress means the list is a wish rather than a state, and the next
 *   compaction has nothing to restore from.
 * - **An empty list means done**, and clears the display. There is no separate
 *   "finish" call to forget.
 */

export type TodoStatus = "pending" | "in_progress" | "done";

export interface TodoItem {
  id: string;
  text: string;
  status: TodoStatus;
}

export interface TodoWriteResult {
  ok: boolean;
  /** Why the write was refused, when it was. */
  error?: string;
  items: TodoItem[];
}

/**
 * The session's list. Held in memory on purpose: it describes what THIS run is
 * doing, and a list restored into a different run would be a plan for work
 * nobody asked for. `plan` is the durable one.
 */
export class TodoStore {
  private items: TodoItem[] = [];

  constructor(private readonly onChange?: (items: TodoItem[]) => void) {}

  list(): TodoItem[] {
    return this.items.map((i) => ({ ...i }));
  }

  /**
   * Replace the list wholesale.
   *
   * Validation refuses rather than repairs. Silently demoting a second
   * `in_progress` would leave the model believing something it can no longer
   * see, which is the exact failure the list exists to prevent — a refusal
   * with a reason costs one turn and leaves both sides in the same state.
   */
  replace(items: TodoItem[]): TodoWriteResult {
    const seen = new Set<string>();
    for (const item of items) {
      if (!item.id || !item.text) {
        return { ok: false, error: "every todo needs an id and text", items: this.list() };
      }
      if (seen.has(item.id)) {
        return { ok: false, error: `duplicate todo id "${item.id}"`, items: this.list() };
      }
      seen.add(item.id);
    }
    const running = items.filter((i) => i.status === "in_progress");
    if (running.length > 1) {
      return {
        ok: false,
        error: `only one todo may be in_progress at a time (got ${running.length}: ${running
          .map((i) => i.id)
          .join(", ")})`,
        items: this.list(),
      };
    }
    this.items = items.map((i) => ({ ...i }));
    this.onChange?.(this.list());
    return { ok: true, items: this.list() };
  }

  /** `done / total`, and what is running — the summary a status line wants. */
  summary(): { done: number; total: number; current?: TodoItem } {
    const done = this.items.filter((i) => i.status === "done").length;
    const current = this.items.find((i) => i.status === "in_progress");
    return { done, total: this.items.length, ...(current ? { current } : {}) };
  }
}

/** One line per item, for a tool result or a transcript line. */
export function formatTodos(items: TodoItem[]): string {
  if (items.length === 0) return "(no todos)";
  const mark: Record<TodoStatus, string> = { pending: "·", in_progress: "▸", done: "✓" };
  return items.map((i) => `${mark[i.status]} ${i.text}`).join("\n");
}
