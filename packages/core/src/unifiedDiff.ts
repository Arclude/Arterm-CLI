/**
 * Unified diff — the machine-readable half of `diff.ts`.
 *
 * `lineDiff` produces rows for a human to look at: line numbers, collapsed
 * context, a row budget. This produces text `git apply` and `patch(1)` accept,
 * which is a different contract — a hunk header whose counts are off by one is
 * not a cosmetic flaw, it is a patch that refuses to apply. The two share
 * `diffOps` so they can disagree about presentation and never about content.
 *
 * The trailing newline is the part everyone gets wrong. A file ending "b\n"
 * and one ending "b" hold the same lines and are not the same file; splitting
 * on "\n" makes them identical arrays and the difference vanishes. Both ends
 * are tracked separately and reported with the `\ No newline at end of file`
 * marker, which is exactly what git writes and what git reads back.
 */

import { diffOps } from "./diff.js";

/** Lines of unchanged context kept on each side of a change. */
const DEFAULT_CONTEXT = 3;

export interface UnifiedDiffOptions {
  /** Path written into the `---` header (a/ prefix is added). */
  fromFile?: string;
  /** Path written into the `+++` header (b/ prefix is added). */
  toFile?: string;
  /** Unchanged lines kept around each change (default 3). */
  context?: number;
  /** Stop after this many body lines and report the rest as hidden. */
  maxLines?: number;
}

export interface UnifiedDiffResult {
  /** The patch text, or "" when the two inputs are identical. */
  text: string;
  hunks: number;
  added: number;
  removed: number;
  /**
   * True when `maxLines` cut the body. A truncated unified diff is NOT a
   * patch — callers must say so rather than hand it to someone to apply.
   */
  truncated: boolean;
}

const NO_NEWLINE = "\\ No newline at end of file";

/** Split file text into lines, separating "has a trailing newline" from content. */
function toLines(text: string): { lines: string[]; eof: boolean } {
  if (text === "") return { lines: [], eof: true };
  const eof = text.endsWith("\n");
  return { lines: (eof ? text.slice(0, -1) : text).split("\n"), eof };
}

/** Render a unified diff of two file contents. */
export function unifiedDiff(
  before: string,
  after: string,
  opts: UnifiedDiffOptions = {},
): UnifiedDiffResult {
  const empty: UnifiedDiffResult = { text: "", hunks: 0, added: 0, removed: 0, truncated: false };
  if (before === after) return empty;

  const context = Math.max(0, opts.context ?? DEFAULT_CONTEXT);
  const a = toLines(before);
  const b = toLines(after);

  let ops = diffOps(a.lines, b.lines);
  // Identical lines but a different ending: the files differ and every op is
  // "eq", so without this the diff would come out empty for a real change.
  // Re-stating the last line as a removal plus an addition is how git shows it.
  if (!ops.some((op) => op.t !== "eq")) {
    if (a.eof === b.eof) return empty;
    const last = ops[ops.length - 1];
    if (!last) return empty;
    ops = [...ops.slice(0, -1), { t: "del", text: last.text }, { t: "add", text: last.text }];
  }

  // The old/new line number each op sits at, before it is consumed.
  const oldAt: number[] = [];
  const newAt: number[] = [];
  let o = 1;
  let n = 1;
  for (const op of ops) {
    oldAt.push(o);
    newAt.push(n);
    if (op.t !== "add") o++;
    if (op.t !== "del") n++;
  }

  // Group changed ops into hunks, merging any two closer than twice the
  // context — otherwise their context windows would overlap and print lines
  // twice, which `patch` reads as a corrupt hunk.
  const groups: Array<[number, number]> = [];
  for (let i = 0; i < ops.length; i++) {
    if (ops[i]?.t === "eq") continue;
    const last = groups[groups.length - 1];
    if (last && i - last[1] <= context * 2) last[1] = i;
    else groups.push([i, i]);
  }
  if (groups.length === 0) return empty;

  const out: string[] = [];
  const from = opts.fromFile ?? "a";
  const to = opts.toFile ?? "b";
  out.push(`--- a/${from}`, `+++ b/${to}`);

  const maxLines = opts.maxLines ?? Number.POSITIVE_INFINITY;
  let added = 0;
  let removed = 0;
  let hunks = 0;
  let truncated = false;
  let body = 0;

  for (const [gs, ge] of groups) {
    if (body >= maxLines) {
      truncated = true;
      break;
    }
    const s = Math.max(0, gs - context);
    const e = Math.min(ops.length - 1, ge + context);

    let oldCount = 0;
    let newCount = 0;
    for (let i = s; i <= e; i++) {
      if (ops[i]?.t !== "add") oldCount++;
      if (ops[i]?.t !== "del") newCount++;
    }
    // A zero-length side is anchored to the line BEFORE the change — an
    // insertion at the top of a file is `-0,0`, not `-1,0`.
    const oldStart = oldCount === 0 ? (oldAt[s] ?? 1) - 1 : (oldAt[s] ?? 1);
    const newStart = newCount === 0 ? (newAt[s] ?? 1) - 1 : (newAt[s] ?? 1);
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    hunks++;

    for (let i = s; i <= e; i++) {
      const op = ops[i];
      if (!op) continue;
      // Checked per line, not per hunk: one rewritten file is a single hunk,
      // so a between-hunks check would let the whole thing through.
      if (body >= maxLines) {
        truncated = true;
        break;
      }
      out.push(op.t === "eq" ? ` ${op.text}` : op.t === "del" ? `-${op.text}` : `+${op.text}`);
      body++;
      if (op.t === "add") added++;
      if (op.t === "del") removed++;
      // The marker belongs to whichever side's final line this was.
      const endsOld = op.t !== "add" && oldAt[i] === a.lines.length && !a.eof;
      const endsNew = op.t !== "del" && newAt[i] === b.lines.length && !b.eof;
      if (endsOld || endsNew) out.push(NO_NEWLINE);
    }
  }

  if (truncated) out.push(`… diff truncated at ${maxLines} lines`);
  return { text: `${out.join("\n")}\n`, hunks, added, removed, truncated };
}

/**
 * The file paths a unified diff would write to, taken from its `+++` headers
 * with `strip` leading components removed — the same accounting `git apply -pN`
 * does.
 *
 * This exists so a caller can confine a patch BEFORE handing it to a patch
 * program. `git apply` bounds paths by the repository, not by the directory it
 * was invoked in, so a patch run from `packages/tools` can legally write to
 * `packages/cli` — outside the tool's working directory and outside anything
 * the permission prompt described. A boundary the patch text can name is not a
 * boundary; the caller checks these against its own root.
 */
export function patchTargets(patch: string, strip = 1): string[] {
  const targets: string[] = [];
  for (const line of patch.split("\n")) {
    if (!line.startsWith("+++ ") && !line.startsWith("--- ")) continue;
    // `+++ b/src/x.ts\t2026-08-07 …` — the path ends at a tab.
    const raw = (line.slice(4).split("\t")[0] ?? "").trim();
    if (raw === "" || raw === "/dev/null") continue;
    // A deletion names the victim only on the `---` side, so both are
    // collected: what a patch READS is as much in scope as what it writes.
    const parts = raw.split("/");
    const stripped = parts.slice(Math.min(strip, parts.length - 1)).join("/");
    if (stripped !== "") targets.push(stripped);
  }
  return [...new Set(targets)];
}
