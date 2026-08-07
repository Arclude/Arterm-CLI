import type { Tool } from "@arterm/core";
import { scrubEnv, withheldNote } from "@arterm/core";
import { startBackground, startedNote } from "./background.js";
import { requireString } from "./paths.js";

/**
 * Obvious-footgun patterns refused even with permission. This is defense-in-depth
 * only — the real guard is the "ask" permission prompt; do not rely on this list.
 */
const DENY = [
  /\brm\s+-[a-z]*[rf][a-z]*\s+(\/|~)(\s|\*|$)/, // rm -rf / , rm -rf ~ , rm -rf /*
  /--no-preserve-root/,
  /\bmkfs\b/,
  /\bdd\b.*\bof=\/dev\//, // dd ... of=/dev/sdX
  /:\(\)\s*\{.*\};\s*:/, // fork bomb
  // Windows (cmd/PowerShell) — whole-drive / system-root wipes. `shell: true`
  // sends these to cmd.exe/PowerShell, so the POSIX patterns above miss them.
  /\bformat\b[^\n]{0,40}\b[a-z]:(?:\\|\s|"|$)/i, // format C:
  /\bformat-volume\b/i,
  /\bclear-disk\b/i,
  /\bcipher\b[^\n]*\/w[:\s]/i, // secure-wipe free space
  /\b(?:rd|rmdir|del)\b[^\n]*?\/s\b[^\n]*?\b[a-z]:\\?(?:\s|"|\*|$)/i, // rd /s C:\
  /\bremove-item\b[^\n]*?-recurse\b[^\n]*?\b[a-z]:\\?(?:\s|"|$)/i, // Remove-Item -Recurse C:\
];

export const bashTool: Tool = {
  name: "bash",
  description:
    "Run a shell command in the working directory and return combined stdout/stderr. " +
    "Uses the system shell. Prefer dedicated tools (read/edit/glob) when they fit.",
  maxOutputBytes: 32_768,
  permission: "ask",
  category: "execute",
  mutating: true,
  riskTier: "destructive",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "Shell command to execute." },
      timeout_ms: { type: "number", description: "Timeout in milliseconds (default 60000)." },
      background: {
        type: "boolean",
        description: "Start it and return an id instead of waiting (needs a process registry).",
      },
    },
    required: ["command"],
  },
  preview: (args) =>
    `bash${args.background === true ? " (background)" : ""}: ${String(args.command)}`,
  async execute(args, ctx) {
    const command = requireString(args, "command");
    if (DENY.some((re) => re.test(command))) {
      return { output: "Command refused: matches a dangerous pattern.", isError: true };
    }
    const timeout = typeof args.timeout_ms === "number" ? args.timeout_ms : 60_000;
    if (ctx.signal?.aborted) return { output: "Command cancelled.", isError: true };
    // Lazy: execa costs ~250ms to import — load it on first shell use, not at startup.
    const { execa } = await import("execa");

    // When a boundary is in force the command is rewritten into argv that
    // enters it (bwrap/seatbelt + the egress proxy), and it must be spawned
    // ARGV-form: `shell: true` would re-run the wrapper's own quoting through a
    // second shell, and a boundary that depends on quoting surviving two passes
    // is not a boundary. A refusal here (cwd outside the write roots) is an
    // error result, never a fall-through to an unsandboxed run.
    let sandboxed: { argv: string[]; env: Record<string, string | undefined> } | undefined;
    if (ctx.sandbox) {
      try {
        sandboxed = await ctx.sandbox.wrap(command, ctx.cwd, ctx.signal);
      } catch (err) {
        return { output: `Sandbox refused the command: ${asMessage(err)}`, isError: true };
      }
    }

    // Detached: the tool returns an id and the process keeps going. Refused
    // when no registry is wired rather than started anyway — an unregistered
    // background process is one nothing will ever stop, which is the leak this
    // feature would otherwise BE.
    if (args.background === true) {
      if (!ctx.processes) {
        return {
          output: "This session has no process registry, so background commands are unavailable.",
          isError: true,
        };
      }
      try {
        const record = await startBackground(
          {
            spawn: sandboxed?.argv ?? [command],
            shell: sandboxed === undefined,
            // Split on whitespace for DISPLAY only: redaction needs to see
            // `--token` and the word after it as separate items. Nothing is
            // executed from this — a real shell split is exactly the parsing
            // `exec` exists to avoid.
            label: command.split(/\s+/),
            ...(sandboxed?.env ? { env: sandboxed.env } : {}),
          },
          ctx,
          ctx.processes,
        );
        return { output: startedNote(record) };
      } catch (err) {
        return { output: `Could not start in the background: ${asMessage(err)}`, isError: true };
      } finally {
        ctx.sandbox?.release();
      }
    }

    // The environment the command actually receives. `extendEnv: false` is the
    // load-bearing half: execa MERGES `env` into `process.env` by default, so
    // handing it a scrubbed map would have passed the originals through
    // regardless — and that default is also why the sandboxed path leaked, the
    // wrapper's `env` being additive rather than the whole environment.
    const { env, withheld } = scrubEnv(
      { ...process.env, ...(sandboxed?.env ?? {}) },
      ctx.credentials,
    );

    // Timeout/cancel must kill the whole process TREE, not just the shell:
    // with `shell: true` the direct child is cmd/sh, and an orphaned grandchild
    // keeps the output pipe open — so `await child` would hang forever (seen on
    // Windows) even after execa's own `timeout` fired. POSIX gets a process
    // group (detached) killed via -pid; Windows gets `taskkill /T /F`.
    const shared = {
      cwd: ctx.cwd,
      reject: false as const,
      all: true as const,
      detached: process.platform !== "win32",
      env,
      extendEnv: false as const,
    };
    const child = sandboxed
      ? execa(sandboxed.argv[0] as string, sandboxed.argv.slice(1), shared)
      : execa(command, { ...shared, shell: true });

    let terminated: "timed out" | "cancelled" | undefined;
    const killTree = (reason: "timed out" | "cancelled") => {
      terminated ??= reason;
      if (!child.pid) return;
      if (process.platform === "win32") {
        void execa("taskkill", ["/pid", String(child.pid), "/T", "/F"], { reject: false });
      } else {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
    };
    const timer = setTimeout(() => killTree("timed out"), timeout);
    timer.unref?.();
    const onAbort = () => killTree("cancelled");
    ctx.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      const result = await child;
      const out = (result.all ?? `${result.stdout}\n${result.stderr}`).trim();
      if (terminated) {
        const note =
          terminated === "timed out"
            ? `Command timed out after ${timeout}ms.`
            : "Command cancelled.";
        return { output: out ? `${out}\n${note}` : note, isError: true };
      }
      if (result.exitCode === 0) return { output: out || "(no output)" };
      // A failure is where the withholding has to become visible — but only
      // where it is plausibly the cause. The command and its output are the
      // evidence: a note fires when one of them names the variable, and stays
      // quiet under a failing test run that never mentioned it.
      const note = withheldNote(withheld, `${command}\n${out}`);
      const tail = `\n[exit code ${result.exitCode}]${note ? `\n${note}` : ""}`;
      return { output: `${out}${tail}`.trim(), isError: true };
    } catch (err) {
      return { output: `Command failed: ${asMessage(err)}`, isError: true };
    } finally {
      clearTimeout(timer);
      ctx.signal?.removeEventListener("abort", onAbort);
      // Per-command sandbox state (masked credential files, proxy leases) is
      // released even when the command threw — leaking it would leave the next
      // command reading a sentinel where the real file should be.
      ctx.sandbox?.release();
    }
  },
};

function asMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
