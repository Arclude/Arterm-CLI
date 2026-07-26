/**
 * One stable accent colour per sub-agent, so a fan-out reads as N distinct
 * workers instead of one gray wall: the transcript lines a sub-agent produces
 * and its live board row get the SAME colour, keyed on the same id.
 *
 * Red is deliberately absent — it means "failed" on the board's state glyph.
 */
export const AGENT_COLORS = ["cyan", "magenta", "yellow", "green", "blue", "white"] as const;

/**
 * Accent colour for the sub-agent identified by `key` (its board-row id, or its
 * role when it has no row — a bare `spawn`).
 *
 * Dispatched ids carry their position in the round (`f1-3`, `r2-1`), so a round's
 * rows walk the palette in order and never collide. Anything else hashes, which
 * keeps a role like "reviewer" on one colour across a session.
 */
export function agentColor(key: string): string {
  const pos = /-(\d+)$/.exec(key);
  const i = pos?.[1]
    ? Number(pos[1]) - 1
    : [...key].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 9973, 7);
  return AGENT_COLORS[i % AGENT_COLORS.length] as string;
}
