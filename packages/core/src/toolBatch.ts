import type { ToolCall } from "./types.js";

/**
 * The paths one tool call touches, and how.
 *
 * `null` means "unknown" and is NOT the same as touching nothing: unparseable
 * or unexpected arguments must end the run rather than be assumed harmless,
 * because the whole admission rule is an argument-derived claim and a call that
 * cannot make the claim has not made it.
 */
export interface PathReservation {
  /** Paths read. Reader↔reader overlap is not a conflict. */
  reads: readonly string[];
  /** Paths written, created or deleted. Any overlap with these is a conflict. */
  writes: readonly string[];
}

/** Paths a batch has claimed so far, accumulated as calls join it. */
interface Claimed {
  reads: string[];
  writes: string[];
}

/**
 * Whether two reserved paths refer to overlapping ground.
 *
 * Not string equality: a directory reservation has to conflict with the files
 * under it, or a tool that searches a tree would run beside a write into that
 * tree and read half of it. Compared as normalized absolute strings — the
 * CALLER resolves them, since only it knows the working directory a relative
 * argument was written against.
 */
function overlaps(a: string, b: string): boolean {
  if (a === b) return true;
  return a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/** True when `next` may join a batch that has already claimed `claimed`. */
function compatible(claimed: Claimed, next: PathReservation): boolean {
  for (const w of next.writes) {
    if (claimed.reads.some((r) => overlaps(w, r))) return false;
    if (claimed.writes.some((o) => overlaps(w, o))) return false;
  }
  for (const r of next.reads) {
    if (claimed.writes.some((w) => overlaps(r, w))) return false;
  }
  return true;
}

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
 *
 * `safe` may answer with a {@link PathReservation} instead of `true`, which is
 * what lets a call that WRITES share a batch. Admission then stops being a
 * property of the tool and becomes one of the call: two writes to different
 * files have nothing to say to each other, while a read and a write of the same
 * file have everything to say and must not overlap. A bare `true` reserves
 * nothing and conflicts with nothing — the existing all-readers behavior,
 * unchanged.
 *
 * The reservation is a claim made from ARGUMENTS, so it is only as good as the
 * argument it was read from. A tool whose real target is inside a body (a patch
 * naming its files in headers) must reserve what the body says, not what a
 * sibling argument claims, and a call whose arguments cannot be understood
 * answers `null` and becomes a barrier.
 */
export function planToolBatches(
  calls: readonly ToolCall[],
  safe: (call: ToolCall) => boolean | PathReservation | null,
  maxWidth: number = MAX_CONCURRENT_TOOLS,
): ToolCall[][] {
  const batches: ToolCall[][] = [];
  // What the batch currently at the end has claimed, or undefined when it is
  // closed. Tracked rather than re-derived from its members, so `safe` is
  // called exactly once per call — it consults the permission ladder, and
  // asking twice would double every trace an inspector prints.
  let claimed: Claimed | undefined;
  for (const call of calls) {
    const verdict = safe(call);
    const reservation: PathReservation | undefined =
      verdict === true ? { reads: [], writes: [] } : verdict || undefined;
    const last = batches.at(-1);
    if (reservation && claimed && last && last.length < maxWidth) {
      if (compatible(claimed, reservation)) {
        last.push(call);
        claimed.reads.push(...reservation.reads);
        claimed.writes.push(...reservation.writes);
        continue;
      }
      // A conflict CLOSES the run rather than skipping this call into a later
      // one: hoisting it past its neighbours is the reordering this planner
      // exists to refuse. It opens the next batch instead, still in place.
    }
    batches.push([call]);
    claimed = reservation
      ? { reads: [...reservation.reads], writes: [...reservation.writes] }
      : undefined;
  }
  return batches;
}
