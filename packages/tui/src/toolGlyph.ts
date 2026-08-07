/**
 * Per-tool glyph and colour.
 *
 * Every tool call in the transcript and on the swarm board currently draws the
 * same `⚙`, so a wall of tool rows carries no information until you read the
 * names. A glyph plus a colour makes the shape of a turn legible at a glance —
 * five reads, an edit, a bash.
 *
 * Colour is the primary differentiator, not the glyph: a font that cannot draw
 * `⌕` still draws the colour, and the ASCII profile drops every glyph to `*`
 * precisely because colour is what survives there.
 *
 * Unknown names (MCP servers, plugins, user tools) fall back rather than
 * failing — the roster is not fixed at build time.
 */

import { glyphs, resolveIconStyle } from "./uiGlyphs.js";

export interface ToolVisual {
  glyph: string;
  color: string;
}

/** Category → (unicode glyph, pastel colour). */
const CATEGORY: Record<string, ToolVisual> = {
  read: { glyph: "▤", color: "#89b4fa" },
  edit: { glyph: "✎", color: "#f9e2af" },
  write: { glyph: "✎", color: "#f9e2af" },
  // Applying a patch or sweeping a regex across the tree is an edit, but not
  // one whose scope a reader can see from the row — its own mark says so.
  patch: { glyph: "⇄", color: "#fab387" },
  diff: { glyph: "±", color: "#f9e2af" },
  data: { glyph: "❴", color: "#f5c2e7" },
  search: { glyph: "⌕", color: "#cba6f7" },
  list: { glyph: "▣", color: "#89b4fa" },
  shell: { glyph: "⌘", color: "#94e2d5" },
  git: { glyph: "⎇", color: "#a6e3a1" },
  web: { glyph: "◈", color: "#89dceb" },
  test: { glyph: "⚗", color: "#a6e3a1" },
  memory: { glyph: "✦", color: "#f5c2e7" },
  plan: { glyph: "☰", color: "#94e2d5" },
  agent: { glyph: "◈", color: "#cba6f7" },
  meta: { glyph: "❏", color: "#a6adc8" },
  done: { glyph: "✓", color: "#a6e3a1" },
  fallback: { glyph: "•", color: "#9399b2" },
};

/** Tool name → category. Kept beside the tool registry's actual names. */
const TOOL_CATEGORY: Record<string, keyof typeof CATEGORY> = {
  read: "read",
  lookup: "read",
  symbols: "read",
  edit: "edit",
  multi_edit: "edit",
  write: "write",
  format: "edit",
  patch: "patch",
  replace: "patch",
  diff: "diff",
  json: "data",
  tree: "list",
  grep: "search",
  glob: "search",
  search: "search",
  tool_search: "search",
  memory_search: "search",
  ls: "list",
  bash: "shell",
  lint: "test",
  test: "test",
  git: "git",
  git_commit: "git",
  web_fetch: "web",
  web_search: "web",
  memo: "memory",
  remember: "memory",
  spawn: "agent",
  spawn_parallel: "agent",
  message: "agent",
  batch: "meta",
  plan: "plan",
  task: "plan",
  task_done: "done",
  todo: "plan",
};

/**
 * The visual for a tool name. `read_file`, `mcp__x__read` and `Read` all land
 * on `read`: a name is matched case-insensitively, then by its last
 * underscore-delimited segment, before falling back.
 */
export function toolVisual(name: string): ToolVisual {
  const lower = name.toLowerCase();
  const direct = TOOL_CATEGORY[lower];
  if (direct) return CATEGORY[direct] as ToolVisual;
  const tail = lower.split("__").pop() ?? lower;
  const byTail = TOOL_CATEGORY[tail];
  if (byTail) return CATEGORY[byTail] as ToolVisual;
  // A last try on the leading word: `read_file`, `web_search_beta`.
  const head = tail.split("_")[0] ?? tail;
  const byHead = TOOL_CATEGORY[head];
  if (byHead) return CATEGORY[byHead] as ToolVisual;
  return CATEGORY.fallback as ToolVisual;
}

/**
 * The glyph alone, honouring the icon profile. Under `ascii` every tool
 * collapses to the generic mark and identity rests entirely on colour.
 */
export function toolGlyph(name: string): string {
  if (resolveIconStyle() === "ascii") return glyphs.tool;
  return toolVisual(name).glyph;
}

/** The colour alone — safe under every profile, which is the point. */
export function toolColor(name: string): string {
  return toolVisual(name).color;
}
