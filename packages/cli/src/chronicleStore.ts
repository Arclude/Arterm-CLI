/**
 * Where the chronicle's bytes land — the MECHANISM half of `core/chronicle.ts`.
 *
 * One JSONL file per session under `$ARTERM_HOME/chronicle/`, appended
 * synchronously. Synchronous on purpose: the ledger's whole claim is that it
 * records what happened, and an async write that loses its tail on a crash
 * records what happened up to a point nobody can identify. A tool call already
 * cost a model round trip; one `appendFileSync` of a few hundred bytes beside
 * it is not the thing to optimise.
 *
 * `ARTERM_HOME`, never `homedir()` — `configIsolation.test.ts` enforces that,
 * and the reason is on the guard: a path built from the OS home is a path the
 * test suite writes into the developer's real directory.
 */

import { appendFileSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { ARTERM_HOME, type ChronicleRecord, type ChronicleSink } from "@arterm/core";

export const CHRONICLE_DIR = join(ARTERM_HOME, "chronicle");

/** The file one session's records live in. */
export function chronicleFile(sessionId: string): string {
  // A session id reaches this from the CLI, not from model output, but it still
  // becomes a filename — so it is reduced to characters that cannot leave the
  // directory rather than trusted to be well-formed.
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, "_") || "session";
  return join(CHRONICLE_DIR, `${safe}.jsonl`);
}

/**
 * A sink that appends to this session's file.
 *
 * Errors are reported to `onError` and otherwise swallowed: `Chronicle.append`
 * already treats a throwing sink as survivable, and this makes the failure
 * visible without making it fatal.
 */
export function createChronicleSink(
  sessionId: string,
  onError?: (err: unknown) => void,
): ChronicleSink {
  const file = chronicleFile(sessionId);
  let ready = false;
  return {
    write(record: ChronicleRecord): void {
      try {
        if (!ready) {
          mkdirSync(CHRONICLE_DIR, { recursive: true });
          ready = true;
        }
        appendFileSync(file, `${JSON.stringify(record)}\n`, "utf8");
      } catch (err) {
        onError?.(err);
      }
    },
  };
}

/**
 * Read one session's records back.
 *
 * A malformed line is DROPPED rather than thrown on, and the count of what was
 * dropped is returned: a half-written tail (the crash this format is meant to
 * survive) must not make the whole ledger unreadable, and `verifyChain` will
 * report the resulting gap on its own terms.
 */
export function readChronicle(sessionId: string): {
  records: ChronicleRecord[];
  unreadable: number;
  file: string;
} {
  const file = chronicleFile(sessionId);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return { records: [], unreadable: 0, file };
  }
  const records: ChronicleRecord[] = [];
  let unreadable = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line) as ChronicleRecord);
    } catch {
      unreadable += 1;
    }
  }
  return { records, unreadable, file };
}

/** Session ids that have a ledger, newest first. */
export function listChronicles(): Array<{ sessionId: string; at: number }> {
  let names: string[];
  try {
    names = readdirSync(CHRONICLE_DIR);
  } catch {
    return [];
  }
  const out: Array<{ sessionId: string; at: number }> = [];
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    try {
      out.push({
        sessionId: name.slice(0, -".jsonl".length),
        at: statSync(join(CHRONICLE_DIR, name)).mtimeMs,
      });
    } catch {
      // Vanished between readdir and stat — not this function's problem.
    }
  }
  return out.sort((a, b) => b.at - a.at);
}
