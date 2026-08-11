/**
 * Putting the terminal back the way we found it — including when nobody asked.
 *
 * Every mode the TUI turns on is a change to a shell the user keeps using after
 * we exit, and a mode left on is not a cosmetic fault: with SGR mouse reporting
 * still enabled, the terminal prints `^[[<0;12;34M` on every click for the rest
 * of that shell's life, and the only cure is `reset`. Hiding the cursor is the
 * same shape — `?25l` outlives us and there is nothing on screen to explain it.
 *
 * The normal path already handled this: Ink unmounts, MultiApp's effect cleanup
 * runs, `runTui`'s `finally` restores. What none of that covers is being killed
 * or crashing, which is exactly when the modes matter most — the run that ends
 * badly is the one that leaves a broken terminal AND no explanation. So the same
 * bytes are also written from signal handlers and from `uncaughtException`.
 *
 * Three properties, each of which has cost somebody an hour somewhere in this
 * repo:
 *
 * - **`writeSync`, never `stdout.write`.** A pipe makes stdout async, and an
 *   async write queued immediately before `process.exit` is a write that never
 *   lands — the same lesson `runHeadlessGoal`'s SIGTERM report is built on.
 * - **The list is the full set, not the modes we think we enabled.** A crashed
 *   child, a resumed session, or a host emulator replaying a snapshot can leave
 *   reporting on that we never turned on; disabling a mode that was already off
 *   costs nothing, while asking "did we set this one?" is a question with a
 *   wrong answer available.
 * - **Cursor first, alt screen second.** The primary buffer has to come back
 *   with a visible cursor whatever state the alternate screen was left in.
 */

import { writeSync } from "node:fs";

const ESC = String.fromCharCode(27);

/**
 * Every mode this TUI can turn on, in the order they must be turned off.
 *
 * `?2004l` (bracketed paste) and `?1004l` (focus reporting) are here even though
 * we never enable them ourselves: Ink's stdin setup and some host terminals do,
 * and this function's contract is "the terminal is usable afterwards", not "our
 * own writes are balanced".
 */
const MODE_RESET =
  `${ESC}[?1000l${ESC}[?1002l${ESC}[?1003l${ESC}[?1006l${ESC}[?1007l` + // mouse reporting + alternate scroll
  `${ESC}[?2004l${ESC}[?1004l` + // bracketed paste, focus events
  `${ESC}[?25h` + // the hardware cursor, back
  `${ESC}[0m`; // and no colour left mid-attribute

/**
 * Writes the restore sequence to fd 1. Idempotent, and safe to call on a closed
 * or broken stdout — a failed restore must never turn an exit into a crash, and
 * must never mask the error that was already on its way out.
 */
export function resetTerminalModes(opts?: { fullscreen?: boolean }): void {
  try {
    writeSync(1, opts?.fullscreen ? `${MODE_RESET}${ESC}[?1049l` : MODE_RESET);
  } catch {
    // Nothing to do and nothing to say: stdout is gone.
  }
}

/**
 * Installs the abnormal-exit restores and returns a disposer.
 *
 * The signals divide on one rule — **whether a listener changes what Node would
 * otherwise do**. For `SIGTERM`, `SIGHUP` and `SIGINT` alike the answer is yes:
 * all three terminate the process by default, and registering ANY listener
 * suppresses that. So each handler must exit itself, with 128+signal (the
 * shell's own convention, and the honest code: the session did not finish).
 *
 * `SIGINT` is not the exception it looks like. Ink registers no SIGINT listener
 * — it handles Ctrl+C as the raw byte `\x03` on stdin (`components/App.js`),
 * which is what an interactive Ctrl+C actually delivers in raw mode, and never
 * reaches this handler. A real `kill -INT` is the only thing that does, and a
 * handler that merely wrote the escape bytes and returned would leave the app
 * RUNNING with its cursor shown, its mouse released and — in fullscreen — the
 * alt screen exited: a live TUI painting over the primary buffer, unkillable by
 * INT. Exiting is what makes the reset true.
 *
 * `uncaughtException` is deliberately NOT handled here for the mirror-image
 * reason: `main.ts` installs its own handler that swallows the error to keep the
 * session alive, so a crash does not end the process, and resetting the terminal
 * under a still-running TUI causes exactly the damage described above. A crash
 * that does end the process runs the normal `finally` restore in `runTui`.
 *
 * The disposer removes every listener, because a second `runTui` in one process
 * (the tests do exactly this) would otherwise stack handlers that write the
 * escape bytes once per past session.
 */
export function installTerminalRestore(opts?: { fullscreen?: boolean }): () => void {
  let done = false;
  const restore = (): void => {
    if (done) return;
    done = true;
    resetTerminalModes(opts);
  };
  const onFatalSignal = (code: number) => (): void => {
    restore();
    process.exit(code);
  };
  const onTerm = onFatalSignal(143);
  const onHup = onFatalSignal(129);
  const onInt = onFatalSignal(130);

  process.on("SIGTERM", onTerm);
  process.on("SIGHUP", onHup);
  process.on("SIGINT", onInt);
  return () => {
    process.off("SIGTERM", onTerm);
    process.off("SIGHUP", onHup);
    process.off("SIGINT", onInt);
  };
}
