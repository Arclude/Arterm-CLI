/**
 * One switchable glyph language for the TUI's chrome.
 *
 * The glyphs were previously written inline at every use — which is how the
 * two boards ended up disagreeing about what "running" looks like (`●` on the
 * swarm board, `▸` on the kanban), and why there was no way to answer a
 * terminal that renders none of them. Components read `glyphs.running`; the
 * profile decides what that draws.
 *
 * Three profiles, chosen once at startup from `ARTERM_TUI_ICON_STYLE`:
 * `unicode` (default), `nerd` (opt-in, needs a Nerd Font installed), and
 * `ascii` — which is not a courtesy. A captured log, a CI transcript and an
 * SSH session into a bare console all render the box-drawing set as noise.
 */

export type IconStyle = "unicode" | "nerd" | "ascii";

export interface UiGlyphs {
  // Identity / chrome
  brand: string;
  prompt: string;
  cursor: string;
  select: string;
  // Outcomes
  success: string;
  failure: string;
  warning: string;
  info: string;
  denied: string;
  // Lifecycle
  running: string;
  idle: string;
  pending: string;
  paused: string;
  resumed: string;
  stopped: string;
  queued: string;
  // Agent / run structure
  fleet: string;
  team: string;
  round: string;
  goal: string;
  phase: string;
  steer: string;
  fallback: string;
  subagentStart: string;
  subagentDone: string;
  worktree: string;
  patch: string;
  plan: string;
  // Session facts
  tool: string;
  /** Marks an image a tool sent to the model — the terminal cannot draw it. */
  image: string;
  filesChanged: string;
  context: string;
  cost: string;
  clock: string;
  folder: string;
  gitBranch: string;
  sessions: string;
  model: string;
  key: string;
  net: string;
  permission: string;
  copied: string;
  rewound: string;
  redone: string;
  // Keys
  tab: string;
  enter: string;
  // Meters
  meterFull: string;
  meterEmpty: string;
}

const UNICODE: UiGlyphs = Object.freeze({
  brand: "◆",
  // The composer caret and the list selector are deliberately different marks.
  // Both mean "here", but one is where you type and the other is which row is
  // selected, and a screen with the same glyph for both reads as one cursor in
  // two places.
  prompt: "›",
  cursor: "▏",
  select: "❯",
  success: "✓",
  failure: "✗",
  // `!` and `i` even in the unicode profile: `⚠` and `ℹ` are double-width in
  // many fonts and missing in others, and a warning that shifts the layout is
  // worse than a warning drawn in ASCII.
  warning: "!",
  info: "i",
  denied: "⊘",
  running: "●",
  idle: "○",
  pending: "·",
  paused: "⏸",
  resumed: "▶",
  stopped: "■",
  queued: "⏳",
  fleet: "⛓",
  team: "⚑",
  round: "◆",
  goal: "◎",
  phase: "▸",
  steer: "↻",
  fallback: "↪",
  subagentStart: "⟳",
  subagentDone: "↩",
  worktree: "⑃",
  patch: "⤓",
  plan: "▤",
  tool: "⚙",
  image: "▨",
  filesChanged: "✎",
  context: "◔",
  cost: "$",
  clock: "◷",
  folder: "▣",
  gitBranch: "⎇",
  sessions: "⧉",
  model: "◈",
  key: "⚿",
  net: "⌁",
  permission: "⊙",
  copied: "⧉",
  rewound: "↶",
  redone: "↷",
  tab: "⇥",
  enter: "⏎",
  meterFull: "█",
  meterEmpty: "░",
} as const);

/** Opt-in Nerd Font profile. Never assumed — `ARTERM_TUI_ICON_STYLE=nerd`. */
const NERD: UiGlyphs = Object.freeze({
  ...UNICODE,
  brand: "󰚩",
  warning: "",
  info: "",
  goal: "󰄉",
  clock: "󰥔",
  folder: "󰉋",
  gitBranch: "",
  sessions: "󰍹",
  model: "󰚩",
  key: "󰌆",
  net: "󰖟",
  tool: "󰒓",
  image: "▨",
  plan: "󰈙",
  fleet: "󰓾",
  context: "󰓡",
  worktree: "",
} as const);

const ASCII: UiGlyphs = Object.freeze({
  brand: "*",
  prompt: ">",
  cursor: "|",
  select: ">",
  success: "+",
  failure: "x",
  warning: "!",
  info: "i",
  denied: "-",
  running: "*",
  idle: "o",
  pending: ".",
  paused: "||",
  resumed: ">",
  stopped: "#",
  queued: "~",
  fleet: "%",
  team: "^",
  round: "+",
  goal: "@",
  phase: ">",
  steer: "~",
  fallback: "->",
  subagentStart: ">>",
  subagentDone: "<<",
  worktree: "Y",
  patch: "v",
  plan: "=",
  tool: "*",
  image: "i",
  filesChanged: "~",
  context: "c",
  cost: "$",
  clock: "t",
  folder: "d",
  gitBranch: "git",
  sessions: "#",
  model: "m",
  key: "k",
  net: "/",
  permission: "?",
  copied: "c",
  rewound: "<",
  redone: ">",
  tab: "tab",
  enter: "ret",
  meterFull: "#",
  meterEmpty: ".",
} as const);

export function resolveIconStyle(env: NodeJS.ProcessEnv = process.env): IconStyle {
  const raw = env.ARTERM_TUI_ICON_STYLE?.trim().toLowerCase();
  if (raw === "nerd" || raw === "nerd-font" || raw === "nerdfont") return "nerd";
  if (raw === "ascii" || raw === "plain") return "ascii";
  return "unicode";
}

export function glyphSet(style: IconStyle = resolveIconStyle()): UiGlyphs {
  if (style === "nerd") return NERD;
  if (style === "ascii") return ASCII;
  return UNICODE;
}

/** Resolved once at startup — the profile cannot change mid-session. */
export const glyphs: UiGlyphs = glyphSet();
