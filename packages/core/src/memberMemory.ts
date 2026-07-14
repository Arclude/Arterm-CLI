/**
 * Per-member private memory: what a team member carries across rounds.
 *
 * Members run isolated and in parallel each round, so a member starts every round
 * from scratch — and the shared blackboard deliberately hands it only its TEAMMATES'
 * entries (`briefFor` filters out `from === self`). The result is amnesia about its
 * own work: what it already tried, what it decided, what it deferred. This is the
 * other half of that picture — a private space only the owning member reads.
 *
 * Two sources feed it: `note` (the member's own `memo` tool — deliberate, high-signal
 * notes to its future self) and `recap` (its round output, captured automatically by
 * the engine so continuity survives even when the member never calls `memo`). Notes
 * outlive recaps, since a stale recap is noise while a decision stays true.
 *
 * Pure in-memory state, owned for the lifetime of one team run. The engine advances
 * `round`, posts recaps, and injects `recall` into the next round's task; the `memo`
 * tool (wired in the CLI session) posts notes.
 */

/** One entry in a member's private memory. */
export interface MemoryEntry {
  /** The round the entry was written in. */
  round: number;
  /** "note" = the member's own `memo`; "recap" = its round output, captured by the engine. */
  kind: "note" | "recap";
  text: string;
}

const MAX_ENTRY_CHARS = 600;
/** Deliberate notes are the point of this feature — keep a deep-ish backlog. */
const MAX_NOTES = 12;
/** Recaps go stale fast; only the last few rounds are worth re-reading. */
const MAX_RECAPS = 3;

function trim(text: string): string {
  const t = text.trim();
  return t.length > MAX_ENTRY_CHARS ? `${t.slice(0, MAX_ENTRY_CHARS)}…` : t;
}

export class MemberMemory {
  /** The round currently being assembled/run. The engine sets this each round. */
  round = 0;
  private readonly byMember = new Map<string, MemoryEntry[]>();

  /** Record a deliberate note a member left for its future self. */
  note(memberId: string, text: string, round?: number): void {
    this.add(memberId, { kind: "note", text, round: round ?? this.round });
  }

  /** Record a member's round output so it remembers what it just did. */
  recap(memberId: string, text: string, round?: number): void {
    this.add(memberId, { kind: "recap", text, round: round ?? this.round });
  }

  /** One member's entries, in writing order (read-only). */
  entries(memberId: string): readonly MemoryEntry[] {
    return this.byMember.get(memberId) ?? [];
  }

  /** Drop all state (called when a fresh team run starts). */
  clear(): void {
    this.byMember.clear();
    this.round = 0;
  }

  /**
   * What a member should re-read entering the current round: its own notes first
   * (they encode decisions), then its recent output. Everything here was written by
   * this member, so unlike the shared board there is nothing to filter by author.
   * Returns "" when the member has no history yet (its first round).
   */
  recall(memberId: string): string {
    const all = this.byMember.get(memberId);
    if (!all || all.length === 0) return "";

    const notes = all.filter((e) => e.kind === "note");
    const recaps = all.filter((e) => e.kind === "recap");
    const lines: string[] = ["[Your private memory — earlier rounds, visible only to you]"];
    if (notes.length > 0) {
      lines.push("Notes you left yourself:");
      for (const e of notes) lines.push(`• (round ${e.round}) ${e.text}`);
    }
    if (recaps.length > 0) {
      lines.push("What you reported:");
      for (const e of recaps) lines.push(`• round ${e.round}: ${e.text}`);
    }
    return lines.join("\n");
  }

  /** Append an entry, trimmed, and prune that kind back to its cap (oldest first). */
  private add(memberId: string, entry: MemoryEntry): void {
    const text = trim(entry.text);
    if (!text) return;
    const list = this.byMember.get(memberId) ?? [];
    list.push({ ...entry, text });
    const cap = entry.kind === "note" ? MAX_NOTES : MAX_RECAPS;
    let excess = list.filter((e) => e.kind === entry.kind).length - cap;
    for (let i = 0; i < list.length && excess > 0; ) {
      if (list[i]?.kind === entry.kind) {
        list.splice(i, 1);
        excess -= 1;
      } else {
        i += 1;
      }
    }
    this.byMember.set(memberId, list);
  }
}
