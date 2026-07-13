import type { Blackboard, EventBus, Tool } from "@arterm/core";
import { optionalString, requireString } from "./paths.js";

/** Runtime bindings for a per-member `message` tool. */
export interface MessageToolOptions {
  /** The shared team blackboard this member writes to. */
  board: Blackboard;
  /** This member's stable id. */
  selfId: string;
  /** This member's display name. */
  selfName: string;
  /** The session bus, for surfacing the note as a `team_message` event. */
  bus: EventBus;
}

/**
 * Builds the `message` tool for one team member. Calling it posts a note to the
 * shared blackboard — either addressed to a teammate (`to`) or broadcast to the
 * whole team — so coordination flows member↔member instead of only through the
 * leader. Teammates receive the note as a board digest at the start of their next
 * round (members run isolated and in parallel, so notes land next round, not live).
 *
 * Per-member (bound to the caller's id + the run's board), so it's constructed in
 * the session's fleet wiring rather than registered in `defaultTools()`.
 */
export function makeMessageTool(opts: MessageToolOptions): Tool {
  const { board, selfId, selfName, bus } = opts;
  return {
    name: "message",
    description:
      "Leave a note on the shared team board for your teammates. Set `to` to a teammate's name to " +
      "address them directly, or omit it to broadcast to the whole team. Use this to hand off " +
      "context, flag a decision, or ask a teammate to adjust — they read it at the start of their " +
      "next round. This does not end your turn.",
    permission: "allow",
    category: "read",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "The note to share with the team." },
        to: {
          type: "string",
          description: "Optional teammate name to address directly; omit to broadcast to everyone.",
        },
      },
      required: ["text"],
    },
    preview(args) {
      const to = optionalString(args, "to");
      return to ? `message ${selfName} → ${to}` : `broadcast from ${selfName}`;
    },
    async execute(args) {
      const text = requireString(args, "text");
      const toRaw = optionalString(args, "to");
      let to: string | undefined;
      let toName: string | undefined;
      let unresolved: string | undefined;
      if (toRaw?.trim()) {
        const target = board.resolve(toRaw);
        if (target) {
          to = target.id;
          toName = target.name;
        } else {
          // Unknown teammate — don't silently drop the note; broadcast it instead.
          unresolved = toRaw.trim();
        }
      }
      board.post({ from: selfId, fromName: selfName, to, toName, kind: "message", text });
      bus.emit({
        type: "team_message",
        round: board.round,
        from: selfId,
        fromName: selfName,
        to,
        toName,
        kind: "message",
        text,
      });
      if (to) return { output: `✓ message sent to ${toName}` };
      if (unresolved)
        return { output: `✓ no teammate "${unresolved}" — broadcast to the whole team instead` };
      return { output: "✓ note posted to the team board" };
    },
  };
}
