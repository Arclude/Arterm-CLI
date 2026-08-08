import type { ToolCall } from "./types.js";

/**
 * How many concurrent calls one batch may hold.
 *
 * Not a correctness bound — the calls in a batch are concurrency-safe by
 * construction — but a resource one. A model that asks for forty files at once
 * would otherwise open forty reads, and the tail of that fan-out is slower than
 * the head for no gain: the win is in overlapping a handful of round-trips, and
 * it flattens out well before this.
 */
export const MAX_CONCURRENT_TOOLS = 8;

/**
 * Split one assistant turn's tool calls into the groups the loop may run at the
 * same time.
 *
 * Consecutive concurrency-safe calls collapse into a batch; anything else gets
 * a batch of its own. RUNS, not a partition: the calls stay in the order the
 * model asked for them, and a call the model placed between two safe ones stays
 * between them. Hoisting the safe calls out — reading three files "first"
 * because they are cheap — would reorder a turn whose author wrote it in an
 * order for a reason, and the failure would surface as a tool seeing a file
 * before the edit that was supposed to precede it.
 *
 * `safe` is asked once per call and its answer is trusted; the caller owns the
 * policy (the tool declaring `concurrent`, and a permission decision that does
 * not prompt). An empty input yields no batches, which is the loop's own
 * "nothing to run".
 */
export function planToolBatches(
  calls: readonly ToolCall[],
  safe: (call: ToolCall) => boolean,
  maxWidth: number = MAX_CONCURRENT_TOOLS,
): ToolCall[][] {
  const batches: ToolCall[][] = [];
  // Whether the batch currently at the end is one more safe calls may join.
  // Tracked rather than re-derived from its first member, so `safe` is called
  // exactly once per call — it consults the permission ladder, and asking twice
  // would double every trace an inspector prints.
  let open = false;
  for (const call of calls) {
    const concurrent = safe(call);
    const last = batches.at(-1);
    if (concurrent && open && last && last.length < maxWidth) {
      last.push(call);
      continue;
    }
    batches.push([call]);
    open = concurrent;
  }
  return batches;
}
