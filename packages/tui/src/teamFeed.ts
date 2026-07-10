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
      return `✗ ${squash(event.error, 88)}`;
    default:
      return undefined;
  }
}

/** Append a line to a member's feed, keeping at most FEED_CAP entries. */
export function appendFeed(feed: string[] | undefined, line: string): string[] {
  const next = [...(feed ?? []), line];
  return next.length > FEED_CAP ? next.slice(next.length - FEED_CAP) : next;
}
