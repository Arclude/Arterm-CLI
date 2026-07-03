/**
 * Pretty diff previews for tool calls, shared by the permission prompt and the
 * transcript. Pure string output: the TUI colours lines by their leading marker
 * — "-" red (removed), "+" green (added), "@" / "…" cyan (section / truncation).
 * The FIRST line of each preview is the one-line summary (tool + path); the rest
 * is the diff body.
 */

import type { DiffRow } from "./types.js";

/** Max diff-body lines shown in a preview before truncating. */
const MAX_LINES = 20;

/** Lines of context kept around each change in a rich diff. */
const CONTEXT = 3;
/** Cap on rendered rows in a rich diff before truncating. */
const MAX_ROWS = 80;
/** Above this old×new line product we skip LCS and show a plain removed/added block. */
const LCS_BUDGET = 250_000;

function splitLines(s: string): string[] {
  return s.length === 0 ? [] : s.split("\n");
}

type Op = { t: "eq" | "del" | "add"; text: string };

/** Ordered LCS diff of two line arrays (equal / deleted / added, in place). */
function lcsDiff(x: string[], y: string[]): Op[] {
  const n = x.length;
  const m = y.length;
  // dp[i][j] = LCS length of x[i:] and y[j:]
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] =
        x[i] === y[j]
          ? (dp[i + 1]![j + 1] ?? 0) + 1
          : Math.max(dp[i + 1]![j] ?? 0, dp[i]![j + 1] ?? 0);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) {
      ops.push({ t: "eq", text: x[i]! });
      i++;
      j++;
    } else if ((dp[i + 1]![j] ?? 0) >= (dp[i]![j + 1] ?? 0)) {
      ops.push({ t: "del", text: x[i]! });
      i++;
    } else {
      ops.push({ t: "add", text: y[j]! });
      j++;
    }
  }
  while (i < n) ops.push({ t: "del", text: x[i++]! });
  while (j < m) ops.push({ t: "add", text: y[j++]! });
  return ops;
}

/**
 * Compute a git-style, line-numbered diff of two file contents: unchanged lines are
 * `context` (with both line numbers), removals are `del`, additions are `add`. Common
 * head/tail are trimmed first (so only the changed region is diffed), unchanged runs
 * larger than the context window collapse behind a `hunk` header, and the whole thing
 * is capped at MAX_ROWS. Returns [] when the contents are identical.
 */
export function lineDiff(before: string, after: string): DiffRow[] {
  const a = splitLines(before);
  const b = splitLines(after);

  // Trim common prefix / suffix so LCS only runs on the region that actually changed.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  if (midA.length === 0 && midB.length === 0) return [];

  const midOps: Op[] =
    midA.length * midB.length > LCS_BUDGET
      ? [
          ...midA.map((text): Op => ({ t: "del", text })),
          ...midB.map((text): Op => ({ t: "add", text })),
        ]
      : lcsDiff(midA, midB);

  const ops: Op[] = [
    ...a.slice(0, start).map((text): Op => ({ t: "eq", text })),
    ...midOps,
    ...a.slice(endA).map((text): Op => ({ t: "eq", text })),
  ];

  // Attach line numbers.
  let oldNo = 0;
  let newNo = 0;
  const rows: DiffRow[] = ops.map((op) => {
    if (op.t === "eq") return { kind: "context", text: op.text, old: ++oldNo, new: ++newNo };
    if (op.t === "del") return { kind: "del", text: op.text, old: ++oldNo };
    return { kind: "add", text: op.text, new: ++newNo };
  });

  return collapseContext(rows);
}

/** Keep only rows within CONTEXT of a change; collapse the gaps behind hunk headers. */
function collapseContext(rows: DiffRow[]): DiffRow[] {
  const keep = new Array(rows.length).fill(false);
  rows.forEach((r, i) => {
    if (r.kind !== "add" && r.kind !== "del") return;
    for (let k = Math.max(0, i - CONTEXT); k <= Math.min(rows.length - 1, i + CONTEXT); k++) {
      keep[k] = true;
    }
  });

  const out: DiffRow[] = [];
  let prev = -1;
  for (let i = 0; i < rows.length; i++) {
    if (!keep[i]) continue;
    if (i > prev + 1) {
      const r = rows[i]!;
      out.push({ kind: "hunk", text: `@@ -${r.old ?? "?"} +${r.new ?? "?"} @@` });
    }
    out.push(rows[i]!);
    prev = i;
    if (out.length >= MAX_ROWS) {
      const hidden = rows.length - i - 1;
      if (hidden > 0) out.push({ kind: "hunk", text: `… ${hidden} more line(s)` });
      break;
    }
  }
  return out;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** Render one replacement as a -/+ hunk (old lines removed, new lines added). */
export function diffHunk(oldStr: string, newStr: string): string[] {
  const out: string[] = [];
  if (oldStr.length > 0) for (const l of oldStr.split("\n")) out.push(`-${l}`);
  if (newStr.length > 0) for (const l of newStr.split("\n")) out.push(`+${l}`);
  return out;
}

/** Cap a body at MAX_LINES, appending a note about how many lines were hidden. */
function clamp(lines: string[], max = MAX_LINES): string[] {
  if (lines.length <= max) return lines;
  return [...lines.slice(0, max), `…${lines.length - max} more line(s)`];
}

/** Preview for a single `edit`: summary header + one -/+ hunk. */
export function editPreview(
  path: string,
  oldStr: string,
  newStr: string,
  replaceAll: boolean,
): string {
  const head = `edit ${path}${replaceAll ? " · all occurrences" : ""}`;
  return [head, ...clamp(diffHunk(oldStr, newStr))].join("\n");
}

/** Preview for a `multi_edit`: summary header + one hunk per edit. */
export function multiEditPreview(
  path: string,
  edits: ReadonlyArray<{ old_string: string; new_string: string }>,
): string {
  const head = `multi_edit ${path} · ${edits.length} edit${edits.length === 1 ? "" : "s"}`;
  const body: string[] = [];
  edits.forEach((e, i) => {
    body.push(`@ edit ${i + 1}`);
    body.push(...diffHunk(e.old_string, e.new_string));
  });
  return [head, ...clamp(body)].join("\n");
}

/** Preview for a `write`: summary header + the new content as added lines. */
export function writePreview(path: string, content: string): string {
  const head = `write ${path} · ${content.length} bytes`;
  const body = content.length > 0 ? content.split("\n").map((l) => `+${l}`) : [];
  return [head, ...clamp(body)].join("\n");
}

/**
 * Diff preview for a tool call by name, or null for tools that don't have a
 * file-diff representation (bash, grep, …). Used to render edit/write/multi_edit
 * calls as readable diffs in both the permission prompt and the transcript.
 */
export function toolCallPreview(name: string, args: Record<string, unknown>): string | null {
  const path = str(args.path);
  if (name === "edit") {
    return editPreview(path, str(args.old_string), str(args.new_string), args.replace_all === true);
  }
  if (name === "write") {
    return writePreview(path, str(args.content));
  }
  if (name === "multi_edit" && Array.isArray(args.edits)) {
    const edits = args.edits
      .filter((e): e is Record<string, unknown> => typeof e === "object" && e !== null)
      .map((e) => ({ old_string: str(e.old_string), new_string: str(e.new_string) }));
    return multiEditPreview(path, edits);
  }
  return null;
}
