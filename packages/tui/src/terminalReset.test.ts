import { describe, expect, it } from "vitest";
import { installTerminalRestore } from "./terminalReset.js";

const SIGNALS = ["SIGTERM", "SIGHUP", "SIGINT"] as const;

function counts(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of SIGNALS) out[s] = process.listenerCount(s);
  return out;
}

describe("terminal restore on abnormal exit", () => {
  it("adds one listener per exit path and takes every one back", () => {
    // The disposer is not tidiness. `runTui` can run twice in one process — the
    // CLI does it when a session is closed and reopened, and the tests do it on
    // every case — so a handler that outlives its session is a handler that
    // writes the escape bytes once per session ever started, from a process that
    // may no longer be a TUI at all.
    const before = counts();
    const dispose = installTerminalRestore({ fullscreen: true });
    const during = counts();
    for (const key of Object.keys(before)) {
      expect(during[key], `${key} listener`).toBe((before[key] ?? 0) + 1);
    }
    dispose();
    expect(counts()).toEqual(before);
  });

  it("is safe to dispose twice", () => {
    // The `finally` calls it, and an outer error path may call it again; the
    // second call must not remove somebody else's listener.
    const before = counts();
    const dispose = installTerminalRestore();
    dispose();
    dispose();
    expect(counts()).toEqual(before);
  });

  it("every signal handler terminates, because registering one suppresses the default", () => {
    // The rule that decides this is invisible in the counts above. SIGTERM,
    // SIGHUP and SIGINT all kill the process by default, and a listener
    // SUPPRESSES that — so a handler that only writes the escape bytes and
    // returns converts a fatal signal into a no-op, leaving a RUNNING TUI whose
    // cursor is shown, whose mouse is released, and whose alt screen has been
    // exited. Ink does not save us on SIGINT: it never registers a listener, it
    // reads Ctrl+C as the raw `\x03` byte, which is a different path entirely.
    const dispose = installTerminalRestore();
    for (const s of SIGNALS) {
      expect(String(process.listeners(s).at(-1)), `${s} handler`).toContain("process.exit");
    }
    dispose();
  });

  it("leaves uncaughtException alone, because the CLI's handler survives the crash", () => {
    // `main.ts` swallows uncaught exceptions to keep the session alive. Resetting
    // the terminal for a process that then keeps rendering is the same damage as
    // above, so this module must not touch that event.
    const before = process.listenerCount("uncaughtException");
    const dispose = installTerminalRestore({ fullscreen: true });
    expect(process.listenerCount("uncaughtException")).toBe(before);
    dispose();
  });
});
