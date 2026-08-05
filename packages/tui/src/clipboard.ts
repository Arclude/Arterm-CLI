/**
 * Clipboard via OSC 52: the terminal itself puts the payload on the system
 * clipboard, so it works over SSH and needs no per-OS helper binaries.
 * Supported by Windows Terminal, iTerm2, kitty, wezterm, and most modern
 * emulators. Payload is capped — terminals silently drop huge sequences.
 */

import { spawn as spawnProcess } from "node:child_process";

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

/** Minimal slice of child_process.spawn that `copyToClipboard` needs (injectable for tests). */
export type ClipboardSpawner = (
  cmd: string,
  args: string[],
) => {
  stdin: { write: (s: string) => void; end: () => void } | null;
  on: (event: "error" | "close", cb: (arg?: unknown) => void) => void;
};

export interface CopyOptions {
  /** Where the OSC 52 fallback is written (the terminal may or may not honor it). */
  stdout?: { write: (s: string) => unknown };
  /** Real TTY session — OS clipboard helpers are worth trying. */
  tty?: boolean;
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  spawner?: ClipboardSpawner;
}

/**
 * Put `text` on the system clipboard by whatever route actually works, and say
 * which one did. OSC 52 alone is not enough: the terminal must implement it,
 * and the one this app ships in (xterm.js) silently drops it by default — a
 * `/copy` that "worked" while the clipboard stayed empty. So on a local TTY
 * the OS helper (wl-copy / xclip / xsel / pbcopy / clip.exe) is tried FIRST,
 * and OSC 52 becomes the fallback. Over SSH the order flips: an OS helper
 * there would set the REMOTE clipboard, which is precisely the wrong one —
 * OSC 52's whole reason to exist is crossing that wire.
 */
export async function copyToClipboard(text: string, opts: CopyOptions = {}): Promise<string> {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const overSsh = Boolean(env.SSH_CONNECTION || env.SSH_TTY);
  const osc52 = (): string | undefined => {
    if (!opts.stdout) return undefined;
    opts.stdout.write(osc52Sequence(text));
    return "osc52";
  };
  if (overSsh) return osc52() ?? "none";

  const tools: Array<{ cmd: string; args: string[]; when: boolean }> = [
    { cmd: "wl-copy", args: [], when: Boolean(env.WAYLAND_DISPLAY) },
    { cmd: "xclip", args: ["-selection", "clipboard"], when: Boolean(env.DISPLAY) },
    { cmd: "xsel", args: ["--input", "--clipboard"], when: Boolean(env.DISPLAY) },
    { cmd: "pbcopy", args: [], when: platform === "darwin" },
    { cmd: "clip.exe", args: [], when: platform === "win32" || Boolean(env.WSL_DISTRO_NAME) },
  ];
  if (opts.tty) {
    const spawner: ClipboardSpawner =
      opts.spawner ??
      ((cmd, args) =>
        // Lazy so importing this module never costs a child_process load.
        spawnProcess(cmd, args, { stdio: ["pipe", "ignore", "ignore"] }));
    for (const tool of tools) {
      if (!tool.when) continue;
      if (await runTool(spawner, tool.cmd, tool.args, text)) return tool.cmd;
    }
  }
  return osc52() ?? "none";
}

/** Spawn one helper, feed it the text, true on exit 0 — false on ENOENT/error/timeout. */
function runTool(
  spawner: ClipboardSpawner,
  cmd: string,
  args: string[],
  text: string,
): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok: boolean): void => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        resolve(ok);
      }
    };
    // A wedged helper must not hang /copy: 2s is generous for a local pipe.
    const timer = setTimeout(() => finish(false), 2_000);
    try {
      const child = spawner(cmd, args);
      child.on("error", () => finish(false));
      child.on("close", (code) => finish(code === 0));
      child.stdin?.write(text);
      child.stdin?.end();
    } catch {
      finish(false);
    }
  });
}
