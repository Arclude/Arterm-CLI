/**
 * The TUI's palette, in one place.
 *
 * Until now every colour was a bare Ink name (`color="cyan"`,
 * `borderColor="magenta"`) written into ~12 components, so there was nowhere to
 * tune the look. Bare names also resolve against the *terminal's own* 16-colour
 * palette, which differs per terminal and per user theme — the same session
 * looks harsh in one terminal and washed out in another, and neither is a
 * choice anyone made.
 *
 * So the values here are pinned truecolor pastels (the Catppuccin Mocha
 * palette, MIT). Components do not have to be rewritten to benefit: the Ink
 * shim in `ink.tsx` routes every `color` / `backgroundColor` / `borderColor`
 * through {@link softColor}, so a hardcoded `"red"` becomes `#f38ba8` at render
 * time. That makes this map the single source of truth for both the semantic
 * tokens below and every ANSI name still written in a component.
 */

/**
 * Ink/ANSI colour name → pastel hex. `softColor` maps name → hex and passes
 * anything already-hex (or unknown, e.g. Ink's `"dim"`) through untouched.
 */
export const pastel = Object.freeze({
  black: "#11111b",
  red: "#f38ba8",
  green: "#a6e3a1",
  yellow: "#f9e2af",
  blue: "#89b4fa",
  magenta: "#cba6f7",
  cyan: "#94e2d5",
  white: "#cdd6f4",
  gray: "#7f849c",
  grey: "#7f849c",
  blackBright: "#585b70",
  redBright: "#eba0ac",
  greenBright: "#b8e8b0",
  yellowBright: "#f5e6b8",
  blueBright: "#89dceb",
  magentaBright: "#b4befe",
  cyanBright: "#99e6da",
  whiteBright: "#ffffff",
  // Extended Catppuccin entries the semantic tokens below reference by name.
  peach: "#fab387",
  pink: "#f5c2e7",
  surface0: "#313244",
  surface1: "#45475a",
  subtext0: "#a6adc8",
} as const);

/**
 * Resolve a colour to its pastel equivalent. Known ANSI names map to a hex;
 * hex values and unknown strings (Ink's `"dim"`) pass through unchanged, and
 * `undefined` stays `undefined` so a caller can spread it without forcing a
 * colour on an element that had none.
 */
export function softColor(color?: string): string | undefined {
  if (!color) return color;
  return (pastel as Record<string, string>)[color] ?? color;
}

/**
 * Whether the host terminal can paint truecolor backgrounds.
 *
 * Gates **backgrounds only** — never foregrounds. A diff row that cannot wash
 * its background still reads through its `+`/`-` marker and colour, whereas a
 * background written to a terminal that strips it leaves the row indented by
 * nothing. Detection follows the chalk convention: no TTY loses, `NO_COLOR`
 * loses, then `COLORTERM`, then `TERM`. Both inputs are parameters so a test
 * can exercise every branch without mutating process state.
 */
export function detectSupportsBackground(
  env: NodeJS.ProcessEnv = process.env,
  isTTY: boolean = process.stdout.isTTY ?? false,
): boolean {
  if (!isTTY) return false;
  if (typeof env.NO_COLOR === "string" && env.NO_COLOR !== "") return false;
  const colorterm = env.COLORTERM ?? "";
  if (/^(truecolor|24bit)$/i.test(colorterm)) return true;
  const term = env.TERM ?? "";
  if (/truecolor|24bit|256(color)?/i.test(term)) return true;
  return colorterm !== "" && colorterm !== "false";
}

/**
 * Whether colour should be emitted at all. `NO_COLOR` is a user saying "this
 * terminal, or my eyes, or the log I am piping to, cannot use colour" — and a
 * UI that answers by only dropping the colour leaves glyph-only cells (`✓ 3`)
 * meaning nothing. Callers pair this with a word form.
 */
export function detectNoColor(env: NodeJS.ProcessEnv = process.env): boolean {
  return typeof env.NO_COLOR === "string" && env.NO_COLOR !== "";
}

export interface Theme {
  /** Body text and anything that must simply be read. */
  textPrimary: string;
  /** Arguments and supporting labels beside a primary one. */
  textSecondary: string;
  /** Metadata, hints, separators — quiet without ANSI dim's terminal quirks. */
  textMuted: string;
  /** Prompts, headings, tool names, the assistant's own label. */
  accent: string;
  /** The USER rail and label. */
  user: string;
  /** The ASSISTANT rail and label. */
  assistant: string;
  /** Tool activity. */
  tool: string;
  success: string;
  warn: string;
  error: string;
  /** Brand accents — the composer frame and the banner. */
  brandPrimary: string;
  brandAccent: string;
  /** Panel fills, only used where {@link Theme.supportsBackground} holds. */
  surface: string;
  surfaceRaised: string;
  /** Default panel border. */
  borderDefault: string;
  /**
   * One step quieter than `borderDefault`, for the rails that repeat down a
   * transcript. Present enough to structure a block, never loud enough that a
   * long session reads as a stack of heavy boxes.
   */
  borderSubtle: string;
  /** A frame asking for an answer (confirm prompts, focused panels). */
  borderActive: string;
  /** Per-board accent, so each overlay keeps an identity of its own. */
  monitor: { swarm: string; sdd: string; session: string };
  /**
   * Diff row washes. Deep, low-luminance tints rather than pastel fills: the
   * foreground — including syntax-highlight colours — has to stay readable on
   * top of them.
   */
  diffAddBg: string;
  diffDelBg: string;
  /** See {@link detectSupportsBackground}. */
  supportsBackground: boolean;
  /** See {@link detectNoColor}. */
  noColor: boolean;
}

export const theme: Theme = Object.freeze({
  textPrimary: pastel.white,
  textSecondary: "#bac2de",
  textMuted: "#6c7086",
  accent: pastel.cyan,
  user: pastel.cyan,
  assistant: pastel.green,
  tool: pastel.yellow,
  success: pastel.green,
  warn: pastel.yellow,
  error: pastel.red,
  brandPrimary: pastel.peach,
  brandAccent: pastel.pink,
  surface: "#181825",
  surfaceRaised: "#1e1e2e",
  borderDefault: pastel.blackBright,
  borderSubtle: pastel.surface0,
  borderActive: pastel.yellow,
  monitor: { swarm: pastel.magenta, sdd: pastel.cyan, session: pastel.cyan },
  diffAddBg: "#1e3b2a",
  diffDelBg: "#3b1f26",
  supportsBackground: detectSupportsBackground(),
  noColor: detectNoColor(),
});
