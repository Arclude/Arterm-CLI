/**
 * Clipboard via OSC 52: the terminal itself puts the payload on the system
 * clipboard, so it works over SSH and needs no per-OS helper binaries.
 * Supported by Windows Terminal, iTerm2, kitty, wezterm, and most modern
 * emulators. Payload is capped — terminals silently drop huge sequences.
 */

const OSC = "]";
const BEL = "";

/** Max characters copied in one OSC 52 write (post-cap, pre-base64). */
export const OSC52_MAX_CHARS = 100_000;

/** Build the OSC 52 escape sequence that copies `text` to the system clipboard. */
export function osc52Sequence(text: string): string {
  const capped = text.length > OSC52_MAX_CHARS ? text.slice(0, OSC52_MAX_CHARS) : text;
  const b64 = Buffer.from(capped, "utf8").toString("base64");
  return `${OSC}52;c;${b64}${BEL}`;
}
