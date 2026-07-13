/**
 * Team blackboard: a per-run shared space that breaks the star topology of team
 * mode. Members run in parallel and isolated each round, so they can't see each
 * other live — but at round boundaries every member's result is posted here, and
 * a member can address a teammate directly with the `message` tool. Before its
 * next round each member is handed the entries meant for it (broadcasts + results
 * from teammates, plus messages addressed to it), so coordination no longer has
 * to funnel through the leader's aggregation.
 *
 * Pure in-memory state, owned for the lifetime of one team run. The engine advances
 * `round` and posts results; the `message` tool (wired in the CLI session) posts
 * directed notes. `briefFor` renders what a member should read entering `round`.
 */

/** One posting on the board. */
export interface BoardEntry {
  /** Author member id (or "leader"). */
  from: string;
  /** Author display name. */
  fromName: string;
  /** Target member id for a directed message; omitted for a broadcast/result. */
  to?: string;
  /** Target display name (directed messages only). */
  toName?: string;
  /** The round the entry was posted in. */
  round: number;
  /** "result" = a member's round output; "message" = an addressed/broadcast note. */
  kind: "result" | "message";
  text: string;
}

/** Minimal roster shape the board needs to resolve `to` names → ids. */
export interface BoardMember {
  id: string;
  name: string;
}

const MAX_ENTRY_CHARS = 600;

function trim(text: string): string {
  const t = text.trim();
  return t.length > MAX_ENTRY_CHARS ? `${t.slice(0, MAX_ENTRY_CHARS)}…` : t;
}

export class Blackboard {
  /** The round currently being assembled/run. The engine sets this each round. */
  round = 0;
  private readonly list: BoardEntry[] = [];
  private roster: BoardMember[] = [];

  /** Register the roster so `resolve` can map a name/id a member typed → a member. */
  setRoster(members: BoardMember[]): void {
    this.roster = members.map((m) => ({ id: m.id, name: m.name }));
  }

  /** Resolve a teammate reference (id or name, case-insensitive) to a roster member. */
  resolve(nameOrId: string): BoardMember | undefined {
    const q = nameOrId.trim().toLowerCase();
    return this.roster.find((m) => m.id.toLowerCase() === q || m.name.toLowerCase() === q);
  }

  /** Append an entry (stamped with the current round unless one is given). */
  post(entry: Omit<BoardEntry, "round"> & { round?: number }): void {
    const text = trim(entry.text);
    if (!text) return;
    this.list.push({
      from: entry.from,
      fromName: entry.fromName,
      to: entry.to,
      toName: entry.toName,
      kind: entry.kind,
      text,
      round: entry.round ?? this.round,
    });
  }

  /** All entries, in posting order (read-only). */
  entries(): readonly BoardEntry[] {
    return this.list;
  }

  /** Drop all state (called when a fresh team run starts). */
  clear(): void {
    this.list.length = 0;
    this.roster = [];
    this.round = 0;
  }

  /**
   * The board digest a member should read entering the current round: entries from
   * EARLIER rounds (parallel members can't see same-round work), authored by someone
   * else, that are either broadcasts/results or addressed to this member. Directed
   * messages are surfaced first and clearly, since they expect a response.
   * Returns "" when there is nothing relevant.
   */
  briefFor(memberId: string): string {
    const relevant = this.list.filter(
      (e) =>
        e.round < this.round && e.from !== memberId && (e.to === undefined || e.to === memberId),
    );
    if (relevant.length === 0) return "";

    const directed = relevant.filter((e) => e.to === memberId);
    const shared = relevant.filter((e) => e.to === undefined);
    const lines: string[] = ["[Team board — from earlier rounds]"];
    for (const e of directed) {
      lines.push(`→ Message to you from ${e.fromName} (round ${e.round}): ${e.text}`);
    }
    for (const e of shared) {
      const tag = e.kind === "result" ? "result" : "note";
      lines.push(`• ${e.fromName} (round ${e.round}, ${tag}): ${e.text}`);
    }
    return lines.join("\n");
  }
}
