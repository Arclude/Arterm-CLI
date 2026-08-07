/**
 * Turning a collected page into the text the model reads.
 *
 * Kept separate from `collector.ts` because this half is pure: it is a function
 * from a list of nodes to a string, so every decision in it — the indentation,
 * the cap, the sentence that says what was cut — is testable without a browser,
 * a page, or a DOM.
 */
import type { RawNode, RawSnapshot } from "./collector.js";

export interface RenderOptions {
  /** How many nodes the collector was allowed to return, for the footer. */
  limit: number;
  /** The mode it was collected in, for the footer's advice. */
  mode: "interactive" | "full";
}

/** `button "Save" [e12] disabled` — one line, with only the state that is set. */
function renderNode(node: RawNode, indent: number): string {
  const parts = [`${"  ".repeat(indent)}- ${node.role}`];
  if (node.name) parts.push(` "${node.name}"`);
  parts.push(` [${node.ref}]`);
  if (node.level !== undefined) parts.push(` level=${node.level}`);
  if (node.value !== undefined) parts.push(` value="${node.value}"`);
  if (node.checked) parts.push(" checked");
  if (node.disabled) parts.push(" disabled");
  if (node.url) parts.push(` → ${node.url}`);
  return parts.join("");
}

/**
 * Render the tree, with the DOM's depths collapsed to display indentation.
 *
 * The collector reports the raw DOM depth, and on a real page that jumps — a
 * button eleven wrappers deep under a heading at depth two would be indented off
 * the right of the terminal, and its relationship to the heading would be
 * unreadable. So the indent counts EMITTED ancestors instead: what is shown is
 * the nesting of the things that were shown.
 */
export function renderSnapshot(snap: RawSnapshot, opts: RenderOptions): string {
  const header = `${snap.url || "(no page)"}${snap.title ? ` — "${snap.title}"` : ""}`;
  if (snap.rootMissing) {
    return `${header}\nThe selector matched no element. Snapshot without it to see the page.`;
  }
  if (snap.nodes.length === 0) {
    return `${header}\n(no elements with an accessible role — the page may still be loading)`;
  }

  const lines: string[] = [];
  const open: number[] = [];
  for (const node of snap.nodes) {
    while (open.length > 0 && (open[open.length - 1] ?? 0) >= node.depth) open.pop();
    lines.push(renderNode(node, open.length));
    open.push(node.depth);
  }

  const interactive = snap.nodes.filter((n) => n.interactive).length;
  const notes = [
    snap.total > snap.nodes.length
      ? `${snap.nodes.length} of ${snap.total} elements (limit ${opts.limit})`
      : `${snap.nodes.length} elements`,
    `${interactive} interactive`,
  ];
  // What was cut is said, and so is the lever for it. A snapshot that silently
  // stops at 200 reads as a page that ends there — the same failure `tree.ts`
  // counts its hidden entries to avoid.
  if (snap.total > snap.nodes.length) {
    notes.push("raise `limit` or narrow with `selector`");
  }
  if (opts.mode === "interactive") {
    notes.push('mode="full" to include page text');
  }
  return `${header}\n${lines.join("\n")}\n[${notes.join(" · ")}]`;
}
