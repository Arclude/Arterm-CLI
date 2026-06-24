/**
 * Pretty diff previews for tool calls, shared by the permission prompt and the
 * transcript. Pure string output: the TUI colours lines by their leading marker
 * — "-" red (removed), "+" green (added), "@" / "…" cyan (section / truncation).
 * The FIRST line of each preview is the one-line summary (tool + path); the rest
 * is the diff body.
 */

/** Max diff-body lines shown in a preview before truncating. */
const MAX_LINES = 20;

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
