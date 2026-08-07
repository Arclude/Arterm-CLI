/**
 * Images the USER attaches — the direction the loop did not have.
 *
 * `Message.images` has existed since the browser wave and its own comment
 * promised "a picture the user pasted", but nothing ever populated it from the
 * user's side: every image reaching a model came from a tool result, which
 * means the model could look at a screenshot it took and not at one you have.
 *
 * The boundary here is the exact INVERSE of `resolveWithin`'s, and that is the
 * whole point of keeping it in its own file. A tool's path argument is model
 * output, so it is confined to the working directory — CVE-2025-59532 is what
 * happens when a tool call gets to name its own root. A path typed into the
 * composer is not model output: a human at the keyboard named a file on their
 * own machine and pressed Enter, and confining that to the project directory
 * would refuse the ordinary case (a screenshot in ~/Pictures) while protecting
 * nobody. So this accepts an absolute path anywhere the user can read, and the
 * rule that keeps it honest is structural: NOTHING in the tool layer may call
 * these functions. The one caller is the composer's submit path.
 *
 * What still applies is everything that is not about location:
 *
 *  - the magic number, because `.png` that is really an HTML error page is a
 *    provider 400 that ends the turn, and because it is what stops "attach my
 *    private key" from being a thing this can do at all;
 *  - the size cap, derived from the loop's base64 ceiling;
 *  - a refusal that NAMES the file and the reason, never a silent drop — the
 *    failure to prevent is a user who believes the model is looking at
 *    something it never received.
 */

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { extname, resolve } from "node:path";
import { MAX_IMAGE_BYTES } from "./agent.js";
import type { ImageContent } from "./types.js";

/** Extensions carried as image content, and the media type each maps to. */
export const IMAGE_EXTS: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/**
 * Largest image inlined, in RAW bytes.
 *
 * Derived from the loop's base64 ceiling rather than chosen separately: base64
 * costs four bytes for every three, so a file above this encodes to something
 * the agent would refuse anyway. Catching it here means the size reported is
 * the file's own, not that of an encoding nobody asked for.
 */
export const MAX_IMAGE_FILE_BYTES = Math.floor((MAX_IMAGE_BYTES * 3) / 4);

/** The media type an extension claims, or undefined for a non-image. */
export function imageMediaType(path: string): string | undefined {
  return IMAGE_EXTS[extname(path).toLowerCase()];
}

/**
 * What the BYTES say the file is, regardless of what it is called.
 *
 * The extension decides whether a file is a candidate at all; this decides what
 * it actually is, and the two disagree more often than they should. A real one
 * on the machine this was written on: `~/Resimler/logo.png` is a JPEG. Nothing
 * is wrong with that file, and refusing it because its name is imprecise would
 * be this feature failing at the first real photo it was handed.
 *
 * Refusal is still the answer when the bytes match NOTHING here, which is the
 * case that matters: a download that returned an HTML error page under a `.png`
 * name is a provider 400 that ends the turn, and this is also what stops
 * "attach my private key" from being possible — a key file is not any of these.
 *
 * Shared with the `read` tool rather than written twice; a check that drifts
 * between two copies is a check that is right in one place.
 */
export function sniffImageType(buf: Buffer): string | undefined {
  const head = buf.subarray(0, 12).toString("latin1");
  if (head.startsWith("\x89PNG\r\n\x1a\n")) return "image/png";
  if (head.startsWith("\xff\xd8\xff")) return "image/jpeg";
  if (head.startsWith("GIF8")) return "image/gif";
  if (head.startsWith("RIFF") && head.slice(8, 12) === "WEBP") return "image/webp";
  return undefined;
}

/** True when the bytes are the format the name claims. */
export function matchesImageMagic(buf: Buffer, mediaType: string): boolean {
  return sniffImageType(buf) === mediaType;
}

/** One image the user attached, with what to show them about it. */
export interface Attachment {
  image: ImageContent;
  /** Where it came from: a path to display, or the clipboard. */
  label: string;
  /** Raw size, for the cost the composer shows before the turn is spent. */
  bytes: number;
}

export interface AttachResult {
  attached: Attachment[];
  /** One line per file that was named and NOT attached, and why. */
  rejected: string[];
}

/**
 * Turn bytes the user chose into an attachment, or say why not.
 *
 * The media type comes from the BYTES, never from the name — see
 * `sniffImageType`. `expected` is only what to say when the bytes are nothing
 * at all, since "clipboard is not an image" and "shot.png is not an image" want
 * different words.
 */
function fromBytes(buf: Buffer, expected: string, label: string): Attachment | string {
  const mediaType = sniffImageType(buf);
  if (!mediaType) {
    return `${label} is named as ${expected} but its bytes are not any image format.`;
  }
  if (buf.length > MAX_IMAGE_FILE_BYTES) {
    const mb = (buf.length / 1_000_000).toFixed(1);
    const cap = (MAX_IMAGE_FILE_BYTES / 1_000_000).toFixed(1);
    return `${label} is ${mb}MB, over the ${cap}MB limit — resize or crop it first.`;
  }
  return {
    image: { mediaType, data: buf.toString("base64") },
    label,
    bytes: buf.length,
  };
}

/**
 * Attach the files the user named.
 *
 * `cwd` resolves a relative path and does NOT confine one — see the header. A
 * path that does not exist is reported by name, because the common cause is a
 * dragged path with a space in it, and "nothing happened" gives no way to know.
 */
export async function attachImageFiles(
  paths: readonly string[],
  cwd: string,
): Promise<AttachResult> {
  const attached: Attachment[] = [];
  const rejected: string[] = [];
  for (const raw of paths) {
    const abs = resolve(cwd, raw);
    const mediaType = imageMediaType(abs);
    if (!mediaType) {
      rejected.push(`${raw} is not a .png/.jpg/.gif/.webp file.`);
      continue;
    }
    let buf: Buffer;
    try {
      buf = await fs.readFile(abs);
    } catch (err) {
      rejected.push(`${raw} could not be read: ${(err as Error).message}`);
      continue;
    }
    const result = fromBytes(buf, mediaType, raw);
    if (typeof result === "string") rejected.push(result);
    else attached.push(result);
  }
  return { attached, rejected };
}

/**
 * Image-file paths mentioned in a typed line.
 *
 * This exists because of what a terminal actually does when you drag a photo
 * onto it: it does not deliver the picture, it types the PATH. So the drop the
 * user performed arrives here as text, and the only way to honour it is to
 * notice it.
 *
 * Quoted forms come first, because a dragged path with a space in it is
 * delivered quoted or backslash-escaped and splitting on whitespace would tear
 * it in half. What is left is scanned for bare tokens with an image extension.
 * The path is NOT removed from the text: the user typed it, it names what they
 * are asking about, and silently editing a person's own sentence is worse than
 * a duplicated path.
 */
export function extractImagePaths(text: string): string[] {
  const found: string[] = [];
  let rest = text;

  /** Consume the matches of one shape, so the bare scan cannot re-find them. */
  const take = (re: RegExp, decode: (inner: string) => string) => {
    rest = rest.replace(re, (whole, inner: string) => {
      const path = decode(inner);
      if (!imageMediaType(path)) return whole;
      found.push(path);
      return " ";
    });
  };

  // file:// is what some desktops drop; %20 in it is a space, not a name.
  take(/\bfile:\/\/(\S+)/g, (inner) => safeDecode(inner));
  // 'single' and "double" quoted runs — how a path with a space arrives.
  take(/'([^']+)'/g, (inner) => inner);
  take(/"([^"]+)"/g, (inner) => inner);

  // Backslash-escaped spaces, the other way a desktop delivers "my shot.png".
  for (const m of rest.matchAll(/(?:[^\s\\]|\\ )+/g)) {
    const token = m[0].replace(/\\ /g, " ");
    if (imageMediaType(token)) found.push(token);
  }
  return [...new Set(found)];
}

/** A malformed percent-escape is a name, not a crash. */
function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/**
 * The token that stands for a pasted image inside the prompt.
 *
 * A picture pasted into a terminal has no pixels to show, so it needs a
 * REPRESENTATION in the line — otherwise the only evidence Ctrl+V did anything
 * is a chip on a rail, and there is no way to change your mind. With a token in
 * the text you can see it, place it in the sentence, and delete it.
 *
 * It stays in the text that goes to the model on purpose. It is not the user's
 * own words — we inserted it — but it says WHERE in the sentence the image
 * belongs, and with several attached it is the only way to write "compare
 * [Image #1] with [Image #2]" and be understood.
 */
export function imagePlaceholder(index: number): string {
  return `[Image #${index}]`;
}

/** An image held in the composer, with the token that represents it. */
export interface PendingAttachment {
  attachment: Attachment;
  placeholder: string;
}

/**
 * The held images whose token is still in the line.
 *
 * Deleting `[Image #1]` is how you take an attachment back, and it has to be
 * the same gesture as deleting anything else you typed. The text is the truth;
 * the held list follows it.
 */
export function stillMentioned(
  text: string,
  held: readonly PendingAttachment[],
): PendingAttachment[] {
  return held.filter((h) => text.includes(h.placeholder));
}

/** A command that writes the clipboard's image to stdout. */
export interface ClipboardReader {
  command: string;
  args: string[];
  /** What to tell the user to install when nothing here is present. */
  install: string;
}

/**
 * An executable the user pointed us at, tried before the built-in readers.
 *
 * The escape hatch for a setup none of them fit — a remote session, a tiling
 * compositor with its own tool, tmux over ssh. It is a PATH to a program that
 * writes image bytes to stdout, taking no arguments: a command string would
 * need quoting rules, and a quoting bug here would read as "no image on the
 * clipboard" rather than as the mistake it is.
 */
export function configuredReader(
  env: NodeJS.ProcessEnv = process.env,
): ClipboardReader | undefined {
  const command = env.ARTERM_CLIPBOARD_CMD?.trim();
  return command ? { command, args: [], install: "ARTERM_CLIPBOARD_CMD" } : undefined;
}

/** How each platform hands over a picture that is on the clipboard. */
export const CLIPBOARD_READERS: ClipboardReader[] = [
  // Wayland first: on a Wayland session with XWayland running, both exist and
  // only wl-paste sees the real clipboard.
  { command: "wl-paste", args: ["--type", "image/png"], install: "wl-clipboard" },
  {
    command: "xclip",
    args: ["-selection", "clipboard", "-t", "image/png", "-o"],
    install: "xclip",
  },
  { command: "pngpaste", args: ["-"], install: "brew install pngpaste" },
];

/**
 * What running one reader actually told us.
 *
 * "Missing" and "ran and had nothing" must not collapse into one answer. They
 * did once, and the result was a Wayland session with wl-clipboard installed
 * being told to install wl-clipboard whenever the clipboard held text — an
 * error pointing at the wrong cause, which is worse than none. `execFile`
 * reports a missing binary as ENOENT; every other failure means it ran.
 */
type ReaderOutcome = { kind: "missing" } | { kind: "nothing" } | { kind: "bytes"; buf: Buffer };

function runReader(command: string, args: string[]): Promise<ReaderOutcome> {
  return new Promise((done) => {
    execFile(
      command,
      args,
      { encoding: "buffer", maxBuffer: MAX_IMAGE_FILE_BYTES * 2, timeout: 5_000 },
      (err, stdout) => {
        if (err) {
          const code = (err as NodeJS.ErrnoException).code;
          done({ kind: code === "ENOENT" ? "missing" : "nothing" });
          return;
        }
        const buf = stdout as Buffer;
        done(buf.length > 0 ? { kind: "bytes", buf } : { kind: "nothing" });
      },
    );
  });
}

/**
 * The picture on the clipboard, if there is one.
 *
 * Every reader is tried rather than one being chosen from `$WAYLAND_DISPLAY`,
 * because the environment answers which display server is running and not which
 * helper is installed — and being wrong about that produces "no image on the
 * clipboard" for a clipboard that has one.
 *
 * A clipboard holding TEXT is not an error worth a red line: the reader exits
 * non-zero or returns bytes that fail the magic check, and both mean the same
 * ordinary thing.
 */
export async function readClipboardImage(
  readers?: readonly ClipboardReader[],
): Promise<{ attachment?: Attachment; error?: string }> {
  const configured = configuredReader();
  const chain = readers ?? (configured ? [configured, ...CLIPBOARD_READERS] : CLIPBOARD_READERS);
  let anyReaderRan = false;
  for (const reader of chain) {
    const outcome = await runReader(reader.command, reader.args);
    if (outcome.kind === "missing") continue;
    // It exists. Whatever happens after this, the answer is about the
    // CLIPBOARD, never about what the user should install.
    anyReaderRan = true;
    if (outcome.kind === "nothing") continue;
    const result = fromBytes(outcome.buf, "image/png", "clipboard");
    if (typeof result !== "string") return { attachment: result };
    return { error: result };
  }
  const installs = chain.map((r) => r.install).join(", ");
  return {
    error: anyReaderRan
      ? "No image on the clipboard."
      : `No clipboard reader found — install one of: ${installs}.`,
  };
}
