import { promises as fs } from "node:fs";
import { join } from "node:path";

/**
 * Age-based pruning for the flat file stores under `$ARTERM_HOME`.
 *
 * Exists because the spool measured 39MB after three weeks of ordinary use:
 * `tool-output/` keeps every clamped tool result so the model can be sent back
 * for the full text, and nothing ever deleted one. Sessions already had
 * retention (`session.maxSessions` / `maxAgeDays`); this is the same idea for
 * the two stores that had none — the spool and the chronicle.
 *
 * Age by MTIME, which is what makes it safe against in-use files with no
 * bookkeeping: an active chronicle is appended to, so its mtime is always
 * fresh, and a spool file the model may still be sent back for is hours old,
 * not days. The cutoff arithmetic is `sessionStore.prune`'s (`>` against
 * `days * DAY_MS`), including its semantics for `0` — older-than-nothing means
 * everything qualifies — so one meaning holds across every retention knob.
 *
 * Best-effort at every level, like the caller it was built for: a store that
 * cannot be pruned must never cost a session its startup. A missing directory
 * is an empty one, a file that vanishes mid-scan is skipped, and the return
 * value exists for tests and `ARTERM_DEBUG`, not for control flow.
 */
const DAY_MS = 24 * 60 * 60 * 1000;

export async function pruneDirByAge(
  dir: string,
  maxAgeDays: number | undefined,
  now: number = Date.now(),
): Promise<string[]> {
  if (maxAgeDays === undefined) return [];
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const entry of entries) {
    // Files only: both stores are flat, and recursing would make a config typo
    // (`spoolDays: 0` pointed at the wrong dir) a directory-tree deletion.
    if (!entry.isFile()) continue;
    const path = join(dir, entry.name);
    try {
      const stat = await fs.stat(path);
      if (now - stat.mtimeMs > maxAgeDays * DAY_MS) {
        await fs.unlink(path);
        removed.push(path);
      }
    } catch {
      // Vanished or unreadable — either way, not ours to fail over.
    }
  }
  return removed;
}
