/**
 * Finding the text an `edit` meant, when it is not byte-identical to the file.
 *
 * Exact matching is the correct default and it fails constantly for one
 * reason: the model reconstructs `old_string` from a file it read several
 * turns ago, and reconstructs the whitespace wrong. Trailing space, tabs vs
 * spaces, an indentation level that shifted since. The call fails, the model
 * re-reads the file, retries, and two turns are gone — the single most common
 * wasted round in an agent session.
 *
 * So this is a LADDER, tried in order, and it stops at the first tier that
 * finds exactly one match:
 *
 *   1. exact
 *   2. exact ignoring trailing whitespace on each line
 *   3. whitespace-normalized — leading indentation and internal runs of
 *      spaces collapse; the replacement is RE-INDENTED to the file's own
 *      indentation so the write does not destroy the block's shape
 *   4. block anchor — first and last line must match (normalized), the
 *      interior is allowed to differ within a small edit distance, and only
 *      when there is a single candidate with a clear margin
 *
 * Two rules make the loose tiers safe. Every tier demands UNIQUENESS: a tier
 * that finds two candidates fails rather than picking one. And the tier that
 * matched is REPORTED to the caller, because a silent fuzzy match is how an
 * edit lands in the wrong place and nobody finds out until the tests do.
 */

export type MatchTier = "exact" | "trailing-space" | "whitespace" | "block-anchor";

export interface MatchResult {
  /** Byte offsets into the source of every match found by the winning tier. */
  ranges: { start: number; end: number }[];
  tier: MatchTier;
  /**
   * The replacement, adapted to what actually matched. For the normalized and
   * anchored tiers this is the caller's `new_string` re-indented to the file's
   * indentation; for the exact tiers it is the caller's string unchanged.
   */
  replacement: string;
}

export interface NoMatch {
  ranges: never[];
  /** Which tier came closest, for an error message that helps. */
  nearest?: { tier: MatchTier; count: number };
}

/** Collapse each line's trailing whitespace. */
function stripTrailing(text: string): string {
  return text
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/, ""))
    .join("\n");
}

/** Leading indentation of the first non-empty line. */
function leadingIndent(text: string): string {
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    return line.slice(0, line.length - line.trimStart().length);
  }
  return "";
}

/**
 * Re-indent `replacement` so its first non-empty line sits at `indent`, moving
 * every other line by the same delta. Without this, a block matched at one
 * indentation is rewritten at the model's remembered indentation — which is
 * exactly the thing we just decided to forgive.
 */
export function reindent(replacement: string, indent: string): string {
  const from = leadingIndent(replacement);
  if (from === indent) return replacement;
  return replacement
    .split("\n")
    .map((line) => {
      if (line.trim() === "") return line;
      return line.startsWith(from) ? indent + line.slice(from.length) : line;
    })
    .join("\n");
}

/** Every offset where `needle` occurs in `haystack`. */
function findAll(haystack: string, needle: string): { start: number; end: number }[] {
  if (needle === "") return [];
  const out: { start: number; end: number }[] = [];
  let from = 0;
  for (;;) {
    const i = haystack.indexOf(needle, from);
    if (i === -1) break;
    out.push({ start: i, end: i + needle.length });
    from = i + needle.length;
  }
  return out;
}

/** Line start offsets, so a line index can become a byte offset. */
function lineOffsets(text: string): number[] {
  const offsets = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") offsets.push(i + 1);
  }
  return offsets;
}

/** Levenshtein distance, capped — the cap is what keeps it cheap on long lines. */
function editDistance(a: string, b: string, cap: number): number {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const v = Math.min(
        (prev[j] as number) + 1,
        (row[j - 1] as number) + 1,
        (prev[j - 1] as number) + cost,
      );
      row.push(v);
      if (v < best) best = v;
    }
    if (best > cap) return cap + 1;
    prev = row;
  }
  return prev[b.length] as number;
}

/** Normalize a line for comparison: no indentation, internal runs collapsed. */
function normLine(line: string): string {
  return line.trim().replace(/\s+/g, " ");
}

/**
 * Tier 3: match on whitespace-normalized lines.
 *
 * Works line-wise rather than on the whole string so the byte range it returns
 * is a real span of the file, and so the file's own indentation is available
 * for re-indenting the replacement.
 */
function whitespaceMatch(
  source: string,
  needle: string,
): { start: number; end: number; indent: string }[] {
  const srcLines = source.split("\n");
  const wanted = needle.split("\n").map(normLine);
  // A single blank normalized line would match everywhere.
  if (wanted.every((l) => l === "")) return [];
  const offsets = lineOffsets(source);
  const out: { start: number; end: number; indent: string }[] = [];
  for (let i = 0; i + wanted.length <= srcLines.length; i++) {
    let ok = true;
    for (let j = 0; j < wanted.length; j++) {
      if (normLine(srcLines[i + j] as string) !== wanted[j]) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    const start = offsets[i] as number;
    const lastIdx = i + wanted.length - 1;
    const end = (offsets[lastIdx] as number) + (srcLines[lastIdx] as string).length;
    const indent = leadingIndent(srcLines.slice(i, i + wanted.length).join("\n"));
    out.push({ start, end, indent });
  }
  return out;
}

/**
 * Tier 4: anchor on the first and last line, tolerate the interior.
 *
 * Deliberately the narrowest of the loose tiers: it requires a block of at
 * least three lines (a two-line "block" is all anchor and no interior, which
 * is tier 3), a single candidate, and an interior close enough that this is
 * plainly the same block rather than a similar one.
 */
function blockAnchorMatch(
  source: string,
  needle: string,
): { start: number; end: number; indent: string; distance: number }[] {
  const wanted = needle.split("\n");
  if (wanted.length < 3) return [];
  const first = normLine(wanted[0] as string);
  const last = normLine(wanted[wanted.length - 1] as string);
  if (first === "" || last === "") return [];

  const srcLines = source.split("\n");
  const offsets = lineOffsets(source);
  const interior = wanted.slice(1, -1).map(normLine).join("\n");
  // Allow roughly a quarter of the interior to differ, floor 8 characters —
  // enough for a renamed identifier or a changed argument, not enough for a
  // different block that happens to start and end the same way.
  const cap = Math.max(8, Math.floor(interior.length / 4));

  const out: { start: number; end: number; indent: string; distance: number }[] = [];
  for (let i = 0; i < srcLines.length; i++) {
    if (normLine(srcLines[i] as string) !== first) continue;
    // The end line is searched at the same block length first, then nearby, so
    // an interior that gained or lost a line still anchors.
    for (let len = wanted.length - 2; len <= wanted.length + 2; len++) {
      const endIdx = i + len - 1;
      if (len < 3 || endIdx >= srcLines.length) continue;
      if (normLine(srcLines[endIdx] as string) !== last) continue;
      const candidate = srcLines
        .slice(i + 1, endIdx)
        .map(normLine)
        .join("\n");
      const distance = editDistance(candidate, interior, cap);
      if (distance > cap) continue;
      const start = offsets[i] as number;
      const end = (offsets[endIdx] as number) + (srcLines[endIdx] as string).length;
      const indent = leadingIndent(srcLines.slice(i, endIdx + 1).join("\n"));
      out.push({ start, end, indent, distance });
      break;
    }
  }
  return out;
}

/**
 * Walk the ladder and return the first tier that matched, or the near misses.
 *
 * `replaceAll` restricts the ladder to the exact tiers: replacing every
 * occurrence of something that only approximately matches is a much larger
 * blast radius than the caller asked for.
 */
export function matchEdit(
  source: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): MatchResult | NoMatch {
  // 1 — exact.
  const exact = findAll(source, oldString);
  if (exact.length > 0 && (replaceAll || exact.length === 1)) {
    return { ranges: exact, tier: "exact", replacement: newString };
  }
  if (exact.length > 1) return { ranges: [], nearest: { tier: "exact", count: exact.length } };

  // 2 — trailing whitespace ignored. Compared on a stripped copy of the file,
  // then mapped back: the stripped copy is only used to LOCATE, never to write.
  const strippedSource = stripTrailing(source);
  const strippedNeedle = stripTrailing(oldString);
  if (strippedNeedle !== oldString || strippedSource !== source) {
    const hits = findAll(strippedSource, strippedNeedle);
    if (hits.length === 1) {
      // Re-locate in the original by line index, since stripping shifts offsets.
      const line = strippedSource.slice(0, (hits[0] as { start: number }).start).split("\n").length;
      const lines = oldString.split("\n").length;
      const offsets = lineOffsets(source);
      const start = offsets[line - 1] as number;
      const endLine = line - 1 + lines - 1;
      const end = (offsets[endLine] as number) + (source.split("\n")[endLine] as string).length;
      if (!replaceAll) {
        return { ranges: [{ start, end }], tier: "trailing-space", replacement: newString };
      }
    }
    if (hits.length > 1) {
      return { ranges: [], nearest: { tier: "trailing-space", count: hits.length } };
    }
  }

  // The loose tiers never run for replace_all.
  if (replaceAll) return { ranges: [] };

  // 3 — whitespace-normalized.
  const ws = whitespaceMatch(source, oldString);
  if (ws.length === 1) {
    const hit = ws[0] as { start: number; end: number; indent: string };
    return {
      ranges: [{ start: hit.start, end: hit.end }],
      tier: "whitespace",
      replacement: reindent(newString, hit.indent),
    };
  }
  if (ws.length > 1) return { ranges: [], nearest: { tier: "whitespace", count: ws.length } };

  // 4 — block anchor, single candidate only.
  const anchored = blockAnchorMatch(source, oldString);
  if (anchored.length === 1) {
    const hit = anchored[0] as { start: number; end: number; indent: string };
    return {
      ranges: [{ start: hit.start, end: hit.end }],
      tier: "block-anchor",
      replacement: reindent(newString, hit.indent),
    };
  }
  if (anchored.length > 1) {
    return { ranges: [], nearest: { tier: "block-anchor", count: anchored.length } };
  }

  return { ranges: [] };
}

/** True when the result is a match rather than a miss. */
export function matched(result: MatchResult | NoMatch): result is MatchResult {
  return result.ranges.length > 0;
}

/** Apply the ranges (right to left, so earlier offsets stay valid). */
export function applyRanges(
  source: string,
  ranges: { start: number; end: number }[],
  replacement: string,
): string {
  let out = source;
  for (const range of [...ranges].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, range.start) + replacement + out.slice(range.end);
  }
  return out;
}
