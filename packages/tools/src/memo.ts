import type { EventBus, MemberMemory, Tool } from "@arterm/core";
import { requireString } from "./paths.js";

/** Runtime bindings for a per-member `memo` tool. */
export interface MemoToolOptions {
  /** The run's per-member memory this member writes to. */
  memory: MemberMemory;
  /** This member's stable id. */
  selfId: string;
  /** This member's display name. */
  selfName: string;
  /** The session bus, for surfacing the note as a `team_memory` event. */
  bus: EventBus;
}

/** Mirrors the board's entry cap so the event stream carries what the member stored. */
const MAX_EVENT_CHARS = 600;

/**
 * Builds the `memo` tool for one team member. Calling it stores a private note that
 * only this member reads, handed back at the start of each of its later rounds. Members
 * run isolated and in parallel, so a member otherwise starts every round with no memory
 * of its own work — this is how a decision, a dead end, or a deferred task survives.
 *
 * Distinct from the two neighbouring tools: `message` shares with teammates, `remember`
 * persists across sessions; `memo` is private to this member and lives for this run.
 *
 * Per-member (bound to the caller's id + the run's memory), so it's constructed in the
 * session's fleet wiring rather than registered in `defaultTools()`.
 */
export function makeMemoTool(opts: MemoToolOptions): Tool {
  const { memory, selfId, selfName, bus } = opts;
  return {
    name: "memo",
    description:
      "Leave a private note for your future self. You run again next round with no memory of " +
      "this one, so record what you decided, what you already tried and ruled out, or what you " +
      "left unfinished — you get these notes back at the start of your next round. Private to " +
      "you: use `message` to tell a teammate something. This does not end your turn.",
    permission: "allow",
    category: "read",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "The note to your future self." },
      },
      required: ["text"],
    },
    preview() {
      return `memo from ${selfName} (private)`;
    },
    async execute(args) {
      const text = requireString(args, "text");
      memory.note(selfId, text);
      bus.emit({
        type: "team_memory",
        round: memory.round,
        member: selfId,
        memberName: selfName,
        kind: "note",
        text: text.length > MAX_EVENT_CHARS ? `${text.slice(0, MAX_EVENT_CHARS)}…` : text,
      });
      return { output: "✓ noted — you'll get this back next round" };
    },
  };
}
