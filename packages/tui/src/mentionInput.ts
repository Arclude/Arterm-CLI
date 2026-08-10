/**
 * The `@`-mention picker's state, with no React in it.
 *
 * Same split as `editing.ts`: what the keys MEAN is arithmetic on strings and
 * belongs in a file a test can drive, while the component only draws the answer.
 * The picker earns this more than most of the composer does, because it is the
 * first thing here that takes ↑/↓ away from something else — and "which handler
 * owns this key right now" is a question worth being able to ask a unit test.
 *
 * Everything assumes the composer's append-only input (`editing.ts`: "the cursor
 * always sits at the end"). That is what makes an open mention identifiable at
 * all: it is the `@` token the line ENDS with, so there is never a question of
 * which of several the user is editing.
 */

/**
 * The query of the mention being typed, or undefined when none is.
 *
 * `@` must open a token — start of line, or whitespace before it — which is the
 * same rule `extractMentions` applies, and for the same reason: `info@arclude.com`
 * is an email address and `git@github.com:x/y` is a remote, and neither should
 * make a file picker appear over what someone is writing.
 *
 * A closed token (anything with a space after it) returns undefined, so the
 * picker disappears the moment the mention is finished rather than lingering
 * over the next word.
 */
export function mentionQuery(value: string): string | undefined {
  const m = /(?:^|\s)@([^\s@]*)$/.exec(value);
  return m ? (m[1] ?? "") : undefined;
}

/**
 * Where the open mention's `@` sits, or undefined when none is open.
 *
 * This is what identifies a mention across keystrokes. The composer only ever
 * APPENDS, so the index of an `@` already typed never moves — which makes it the
 * one stable name for "this mention" while its query grows. Esc remembers it,
 * and the next `@` gets a different one and opens normally.
 */
export function mentionStart(value: string): number | undefined {
  const m = /(?:^|\s)@([^\s@]*)$/.exec(value);
  if (!m) return undefined;
  return value.length - (m[1] ?? "").length - 1;
}

/** A candidate and where it matched, kept together so the ranking can be tested. */
interface Scored {
  path: string;
  /** Lower is better. */
  rank: number;
}

/**
 * Candidates matching the query, best first.
 *
 * Substring rather than fuzzy subsequence, deliberately. A subsequence matcher
 * makes `ate` find `agent.ts` and also eighty other files that merely contain
 * an a, a t and an e in that order; the cost is not the list length but that the
 * top row stops being predictable — and this is a picker where the top row is
 * what Enter takes.
 *
 * The ranking is: a hit in the FILE NAME beats one in a directory (typing `agent`
 * means the file, not `agent-stuff/README.md`), an earlier hit beats a later one,
 * and a shorter path breaks the tie — which puts `src/app.ts` above
 * `vendor/copy/src/app.ts` without a special case for either.
 *
 * "Earlier" is measured within the FILENAME for a filename hit, not within the
 * whole path. Measured from the start of the string, `agent` scores better in
 * `packages/tui/src/agentColor.ts` than in `packages/core/src/agent.ts` — purely
 * because `tui` is shorter than `core` — so the top row was decided by the
 * length of a directory name nobody typed.
 */
export function filterCandidates(
  query: string,
  candidates: readonly string[],
  limit = 50,
): string[] {
  const q = query.toLowerCase();
  if (q === "") return candidates.slice(0, limit);
  const scored: Scored[] = [];
  for (const path of candidates) {
    const lower = path.toLowerCase();
    const at = lower.indexOf(q);
    if (at < 0) continue;
    const slash = lower.lastIndexOf("/");
    const inName = at > slash;
    const offset = inName ? at - (slash + 1) : at;
    scored.push({ path, rank: (inName ? 0 : 1_000_000) + offset * 1000 + path.length });
  }
  scored.sort((a, b) => a.rank - b.rank || a.path.localeCompare(b.path));
  return scored.slice(0, limit).map((s) => s.path);
}

/**
 * Replace the open mention with the chosen path.
 *
 * A path containing a space is quoted, because the bare form is read to the next
 * space and would otherwise be handed back to `extractMentions` cut in half —
 * the picker inserting something the reader cannot parse is the one bug a picker
 * has no excuse for.
 *
 * A trailing space closes the token, which both ends the picker (the query no
 * longer parses) and separates the path from whatever is typed next.
 */
export function applyMention(value: string, path: string): string {
  const m = /(?:^|\s)@([^\s@]*)$/.exec(value);
  if (!m) return value;
  const head = value.slice(0, value.length - (m[1] ?? "").length);
  const quoted = /\s/.test(path) ? `"${path}"` : path;
  return `${head}${quoted} `;
}

/**
 * Step the highlighted row, wrapping at both ends.
 *
 * Wrapping rather than clamping because the list is short and the alternative is
 * a key that silently does nothing at the bottom — in a box with no scrollbar,
 * "nothing happened" and "this is the last row" are the same observable.
 */
export function movePick(index: number, delta: number, count: number): number {
  if (count <= 0) return 0;
  return (((index + delta) % count) + count) % count;
}
