/**
 * Files the USER names with `@` — the text half of what `attachments.ts` does
 * for pictures.
 *
 * The two are deliberately the same shape, and share one boundary argument. A
 * tool's `path` argument is model output, so `resolveWithin` confines it to the
 * working directory; that is the CVE-2025-59532 lesson and it does not bend. A
 * path typed into the composer is not model output — a human at the keyboard
 * picked a file on their own machine and pressed Enter — and confining it would
 * refuse the ordinary case (a log in `/var/log`, a note in `~/`) while
 * protecting nobody. So this resolves anywhere the user can already read, and
 * what keeps the exception honest is structural rather than a comment: NOTHING
 * in the tool layer may call these functions. The one caller is the composer's
 * submit path.
 *
 * What still applies is everything that is not about location:
 *
 *  - a file that is not TEXT is refused, because pasting a binary into a prompt
 *    spends the turn's budget on mojibake and, on some providers, fails the
 *    request outright;
 *  - a size ceiling, because the mentioned text is re-sent on every iteration of
 *    the turn (see CLAUDE.md's prompt-caching note) rather than once;
 *  - a refusal that NAMES the file and the reason. The failure to prevent is a
 *    user who believes the model is reading something it never received — the
 *    same rule `attachImageFiles` follows, for the same reason.
 *
 * Where the two differ is what happens at the ceiling. An over-large image is
 * refused, because half an image is not a smaller image. An over-large file is
 * CLIPPED and said so, in the block itself: the user asked for this file by
 * name, most of it is usually the answer, and a silent truncation is the one
 * outcome that must not happen — a model reading two thirds of a file while
 * believing it read all of it draws confident wrong conclusions.
 */

import { promises as fs } from "node:fs";
import { basename, resolve } from "node:path";

/**
 * Largest mentioned file carried whole, in bytes.
 *
 * This is a SPEND limit, not a display one. The loop re-sends the entire prompt
 * on every tool call, so a mentioned file is billed once per iteration of the
 * turn — a 400KB file across a twenty-call turn is 8MB of input. 128KB is
 * roughly 32k tokens, which is already a large fraction of a modest context
 * window, and past it the clip note tells both the model and the user what they
 * are looking at.
 */
export const MAX_MENTION_BYTES = 128 * 1024;

/** Largest total across every file one line mentions. */
export const MAX_MENTION_TOTAL_BYTES = 256 * 1024;

/** How much of a file is read to decide whether it is text at all. */
const SNIFF_BYTES = 8192;

export interface Mention {
  /** As the user wrote it — what the block is headed with, and what a refusal names. */
  label: string;
  /** The resolved absolute path, for de-duplication. */
  path: string;
  /** The file's text, clipped if it was over the ceiling. */
  text: string;
  /** Raw size on disk, before any clipping. */
  bytes: number;
  /** True when `text` is not the whole file. */
  clipped: boolean;
}

export interface MentionResult {
  mentions: Mention[];
  /** One line per file that was named and NOT included, and why. */
  rejected: string[];
}

/**
 * Whether these bytes are text.
 *
 * A NUL byte is the test, which is the same one `git diff` uses to decide a
 * file is binary, and it is deliberately not an extension check: the files
 * people mention most often (`Makefile`, `.env.example`, a log with no suffix)
 * have no extension to check, and an allow-list of suffixes would refuse them
 * while admitting a `.txt` that is really a core dump.
 */
export function looksLikeText(buf: Buffer): boolean {
  return !buf.subarray(0, SNIFF_BYTES).includes(0);
}

/**
 * Trim to `max` bytes keeping both ends, and SAY what was dropped.
 *
 * The same shape as `sdd.ts`'s handoff clip and for the same reason: a source
 * file's imports and exports sit at opposite ends, and either one alone answers
 * a different question than the pair. The note is inside the returned text
 * rather than beside it, so it survives into the prompt — a model told it is
 * reading an excerpt will say so, and one that was not told will not.
 */
function clipText(text: string, max: number): string {
  if (Buffer.byteLength(text) <= max) return text;
  const head = Math.floor(max * 0.6);
  const tail = max - head;
  const omitted = Buffer.byteLength(text) - max;
  return `${text.slice(0, head)}\n\n… (${omitted} bytes omitted from the middle of this file) …\n\n${text.slice(-tail)}`;
}

/**
 * Paths named with `@` in a typed line.
 *
 * `@` must open a token — preceded by the start of the line or by whitespace —
 * which is what keeps `info@arclude.com` and a `user@host:path` scp target from
 * being read as file mentions. Both are things people type into a prompt, and
 * both would otherwise produce a refusal line for a file nobody named.
 *
 * Quoted forms are read first so `@"my notes.md"` survives; a bare token runs to
 * the next space. Trailing sentence punctuation is dropped, because "look at
 * @src/a.ts." is a sentence and `a.ts.` is not a file — a filename genuinely
 * ending in one of those characters is rarer than a prompt ending in one.
 *
 * The token is NOT removed from the text. The user typed it, it names what they
 * are asking about, and it is how they say WHICH file a sentence is about when
 * several are attached — the same argument `imagePlaceholder` makes for staying
 * in the line.
 */
export function extractMentions(text: string): string[] {
  const found: string[] = [];
  let rest = text;

  const take = (re: RegExp) => {
    rest = rest.replace(re, (_whole, inner: string) => {
      if (inner) found.push(inner);
      return " ";
    });
  };

  take(/(?:^|(?<=\s))@"([^"]+)"/g);
  take(/(?:^|(?<=\s))@'([^']+)'/g);

  for (const m of rest.matchAll(/(?:^|(?<=\s))@(\S+)/g)) {
    const token = (m[1] ?? "").replace(/[.,;:!?)\]}]+$/, "");
    if (token) found.push(token);
  }
  return [...new Set(found)];
}

/**
 * Read the files the user named, or say why not.
 *
 * `cwd` resolves a relative path and does NOT confine one — see the header.
 * Reading stops at the total ceiling rather than skipping ahead to a smaller
 * file further down the line: the order is the user's, and quietly preferring
 * whichever files happen to be small would produce a block whose contents
 * nobody chose.
 */
export async function readMentions(
  paths: readonly string[],
  cwd: string,
  limits: { perFile?: number; total?: number } = {},
): Promise<MentionResult> {
  const perFile = limits.perFile ?? MAX_MENTION_BYTES;
  const total = limits.total ?? MAX_MENTION_TOTAL_BYTES;
  const mentions: Mention[] = [];
  const rejected: string[] = [];
  const seen = new Set<string>();
  let spent = 0;

  for (const raw of paths) {
    const abs = resolve(cwd, raw);
    if (seen.has(abs)) continue;
    seen.add(abs);

    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(abs);
    } catch (err) {
      rejected.push(`${raw} could not be read: ${(err as Error).message}`);
      continue;
    }
    if (stat.isDirectory()) {
      rejected.push(`${raw} is a directory — name a file, or ask about the directory in words.`);
      continue;
    }
    if (spent >= total) {
      rejected.push(
        `${raw} was left out — this line already mentions ${Math.round(total / 1024)}KB.`,
      );
      continue;
    }

    let buf: Buffer;
    try {
      buf = await fs.readFile(abs);
    } catch (err) {
      rejected.push(`${raw} could not be read: ${(err as Error).message}`);
      continue;
    }
    if (!looksLikeText(buf)) {
      rejected.push(
        `${raw} is not a text file — a picture can be attached, other binaries cannot.`,
      );
      continue;
    }

    // The per-file ceiling and what is LEFT of the total, whichever binds first.
    const room = Math.min(perFile, total - spent);
    const whole = buf.toString("utf8");
    const text = clipText(whole, room);
    mentions.push({
      label: raw,
      path: abs,
      text,
      bytes: buf.length,
      clipped: text !== whole,
    });
    spent += Math.min(buf.length, room);
  }
  return { mentions, rejected };
}

/**
 * The mentioned files as a block appended to what the user typed.
 *
 * Fenced and headed by the path, because the alternative — pasting the contents
 * inline — leaves a model unable to tell the user's own words from the file's,
 * which matters most for the case this feature exists for: asking a question
 * ABOUT a file whose text contains instructions.
 *
 * Returns "" when nothing was read, rather than an empty section. "The files
 * you mentioned: (none)" reads as a failure report for a line that mentioned
 * nothing, which is most lines.
 */
export function mentionBlock(mentions: readonly Mention[]): string {
  if (mentions.length === 0) return "";
  const blocks = mentions.map((m) => {
    const note = m.clipped ? " (excerpt — see the omission note inside)" : "";
    return `### ${m.label}${note}\n\n\`\`\`\n${m.text}\n\`\`\``;
  });
  return `The user attached these files by name:\n\n${blocks.join("\n\n")}`;
}

/** What the composer shows about a mention before the turn is spent. */
export function mentionSummary(mentions: readonly Mention[]): string {
  const bytes = mentions.reduce((n, m) => n + m.bytes, 0);
  const kb = bytes < 1024 ? `${bytes}B` : `${Math.round(bytes / 1024)}KB`;
  const names = mentions.map((m) => basename(m.label)).join(", ");
  return `${mentions.length} file(s), ${kb} — ${names}`;
}
