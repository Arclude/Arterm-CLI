/**
 * Deleting a temp directory that a child process just used. Test-only — nothing
 * in `index.ts` imports it, so it never ships.
 *
 * POSIX unlinks a path whose file another process still holds open; Windows
 * refuses, with `EBUSY: resource busy or locked, rmdir …`. That lands in
 * `afterEach`, so it fails a test whose own assertions all passed — and it is
 * invisible on the developer's machine, which is why a whole package's worth of
 * it surfaced only on the first Windows CI leg this repository ever ran.
 *
 * Killing a process is not the same as waiting for it: the handles go a beat
 * after the exit. Retrying is the honest fix, because the wait has no event to
 * hang off.
 */

import { promises as fs } from "node:fs";

/** Codes Windows raises for "something still has this open"; anything else is real. */
const TRANSIENT = new Set(["EBUSY", "ENOTEMPTY", "EPERM", "EACCES"]);

export async function rmWithRetry(target: string, attempts = 20, waitMs = 50): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    try {
      await fs.rm(target, { recursive: true, force: true });
      return;
    } catch (err) {
      if (!TRANSIENT.has((err as NodeJS.ErrnoException).code ?? "")) throw err;
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  // Out of attempts: a leftover temp directory is not worth failing a green
  // test over — the OS reaps it, and the alternative is a flake nobody can read.
}
