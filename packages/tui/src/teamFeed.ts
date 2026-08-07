/**
 * Per-member activity feed for the /team board's drill-down view. Bridged
 * member events (tool calls/results, messages) are formatted into compact
 * single lines and kept in a bounded ring per member id. Pure functions —
 * the App holds the state.
 */
import type { AgentEvent } from "@arterm/core";

/** Max feed lines kept per member. */
export const FEED_CAP = 100;

function squash(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** One compact feed line for a bridged member event, or undefined to skip it. */
export function formatMemberEvent(event: AgentEvent): string | undefined {
  switch (event.type) {
    case "tool_call": {
      const args = JSON.stringify(event.call.arguments ?? {});
      return `⚙ ${event.call.name} ${squash(args, 64)}`;
    }
    case "tool_result":
      return `${event.isError ? "└ ✗" : "└ ✓"} ${squash(event.output, 88)}`;
    case "tool_denied":
      return `└ ⊘ ${event.name} denied${event.reason ? `: ${squash(event.reason, 48)}` : ""}`;
    case "assistant_message": {
      const text = squash(event.message.content, 88);
      return text ? `✎ ${text}` : undefined;
    }
    case "error":
      return `✗ ${event.kind ? `[${event.kind}] ` : ""}${squash(event.error, 88)}`;
    case "provider_fallback":
      return `↪ ${event.reason} — ${event.to.provider}/${event.to.model}`;
    // Why a worker stopped, and whether it was stuck. `subagent.ts` bridges all
    // four of these deliberately — a worker that hit its cap looked identical
    // to one that finished, and a looping worker looked like a busy one — but
    // the formatter dropped them on the floor, so the feed showed the silence
    // rather than the reason for it.
    case "loop_detected":
      return `↻ looping — the same step ran ${event.streak}×, steered`;
    case "loop_cut":
      return `■ cut: the same step repeated ${event.streak}× without progress`;
    case "run_limit":
      return `⚠ stopped: ${event.kind === "tokens" ? "token budget" : "iteration cap"} reached (${event.limit})`;
    case "autonomy_stopped":
      return `■ ${squash(event.reason, 88)}`;
    case "autonomy_done":
      return `✓ ${squash(event.summary, 88)}`;
    default:
      return undefined;
  }
}

/** Append a line to a member's feed, keeping at most FEED_CAP entries. */
export function appendFeed(feed: string[] | undefined, line: string): string[] {
  const next = [...(feed ?? []), line];
  return next.length > FEED_CAP ? next.slice(next.length - FEED_CAP) : next;
}
