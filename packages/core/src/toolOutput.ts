/**
 * What a tool's output costs, and which half of it survives.
 *
 * Two problems, one file.
 *
 * THE DIRECTION OF THE CUT. Every truncation in this codebase kept the HEAD:
 * `slice(0, n) + "…"`. For a command's output that is precisely backwards — a
 * build prints a thousand lines of progress and the error on the last one, a
 * test run prints the failures at the bottom, a stack trace ends at the cause.
 * Cutting from the front throws away the answer and keeps the preamble. This
 * was already learned once, in `taskPrompt()`'s handoff clipping ("the
 * conclusion is at the bottom"), and never applied to tool output.
 *
 * So the clamp keeps BOTH ends and cuts the middle, where a long output is
 * most often repetition.
 *
 * THE CEILING. Each tool capped itself with its own constant — `read` at one
 * number, `grep` by match count, the transcript at 400 characters — and an MCP
 * or plugin tool, which is written by someone else entirely, capped itself at
 * nothing. One megabyte of JSON from a third-party tool lands in the context,
 * costs a fifth of a small model's window, and is never seen again because the
 * next compaction throws it out. The ceiling belongs where every tool passes.
 *
 * What is cut is not lost: the full output is written to disk and the result
 * says where, so the model can grep the file instead of re-running the command
 * that produced it.
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";
import { ARTERM_HOME } from "./config.js";

/**
 * Backstop for a tool that declares no ceiling of its own.
 *
 * Generous on purpose: this is not a budget, it is a guard against a tool
 * returning something absurd. A tool with a real opinion about its output
 * sets `maxOutputBytes` and gets that instead.
 */
export const DEFAULT_MAX_OUTPUT_BYTES = 200_000;

/** Where full outputs are spooled. */
export function spoolDir(home: string = ARTERM_HOME): string {
  return join(home, "tool-output");
}

export interface ClampResult {
  text: string;
  /** True when anything was removed. */
  truncated: boolean;
  /** Bytes the original occupied. */
  originalBytes: number;
}

/**
 * Clamp to `maxBytes`, keeping the head and the tail.
 *
 * Measured in BYTES rather than characters because that is what the ceiling is
 * about, and cut on CHARACTER boundaries because a string sliced mid-surrogate
 * is a replacement character in the transcript and, worse, in whatever the
 * model tries to quote back. The search walks characters and stops before the
 * budget, so the result is always within it.
 */
export function clampMiddle(text: string, maxBytes: number): ClampResult {
  const originalBytes = Buffer.byteLength(text, "utf8");
  if (originalBytes <= maxBytes || maxBytes <= 0) {
    return { text, truncated: false, originalBytes };
  }

  // The marker is part of the budget: a clamp that returns more than it was
  // asked for is not a clamp.
  const marker = (cut: number) => `\n… [${cut} bytes cut from the middle] …\n`;
  const markerBudget = Buffer.byteLength(marker(originalBytes), "utf8");
  const half = Math.max(0, Math.floor((maxBytes - markerBudget) / 2));
  if (half === 0) return { text: marker(originalBytes).trim(), truncated: true, originalBytes };

  // Head: characters from the front until the next one would exceed `half`.
  let head = "";
  let headBytes = 0;
  for (const ch of text) {
    const size = Buffer.byteLength(ch, "utf8");
    if (headBytes + size > half) break;
    head += ch;
    headBytes += size;
  }
  // Tail: the same walk from the back. Iterating the string gives whole code
  // points, so a surrogate pair is never split.
  const chars = [...text];
  let tail = "";
  let tailBytes = 0;
  for (let i = chars.length - 1; i >= 0; i--) {
    const ch = chars[i] as string;
    const size = Buffer.byteLength(ch, "utf8");
    if (tailBytes + size > half) break;
    tail = ch + tail;
    tailBytes += size;
  }

  const cut = originalBytes - headBytes - tailBytes;
  return { text: head + marker(cut) + tail, truncated: true, originalBytes };
}

/**
 * Write the full output where the model can go back for it.
 *
 * Returns the path, or undefined if the write failed — spooling is a
 * convenience, and a tool call must not fail because a cache directory is
 * read-only.
 */
export async function spoolOutput(
  text: string,
  toolName: string,
  dir: string = spoolDir(),
  now: number = Date.now(),
): Promise<string | undefined> {
  try {
    await fs.mkdir(dir, { recursive: true });
    const file = join(dir, `${now}-${toolName}-${Math.random().toString(36).slice(2, 8)}.txt`);
    await fs.writeFile(file, text, "utf8");
    return file;
  } catch {
    return undefined;
  }
}

/**
 * Delete spooled outputs older than `maxAgeMs` (default 7 days).
 *
 * Called at session teardown rather than on every write: the directory grows
 * by at most a few files per session, and a sweep on the write path would add
 * a directory listing to a tool call that is already over budget.
 */
export async function sweepSpool(
  dir: string = spoolDir(),
  maxAgeMs = 7 * 24 * 60 * 60 * 1000,
  now: number = Date.now(),
): Promise<number> {
  let removed = 0;
  try {
    for (const name of await fs.readdir(dir)) {
      const file = join(dir, name);
      try {
        const stat = await fs.stat(file);
        if (now - stat.mtimeMs > maxAgeMs) {
          await fs.rm(file, { force: true });
          removed++;
        }
      } catch {
        // A file that vanished between listing and stat is already swept.
      }
    }
  } catch {
    // No spool directory yet — nothing to sweep.
  }
  return removed;
}
