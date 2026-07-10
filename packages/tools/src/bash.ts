import type { Tool } from "@arterm/core";
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
  permission: "ask",
  category: "execute",
  mutating: true,
  riskTier: "destructive",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "Shell command to execute." },
      timeout_ms: { type: "number", description: "Timeout in milliseconds (default 60000)." },
    },
    required: ["command"],
  },
  preview: (args) => `bash: ${String(args.command)}`,
  async execute(args, ctx) {
    const command = requireString(args, "command");
    if (DENY.some((re) => re.test(command))) {
      return { output: "Command refused: matches a dangerous pattern.", isError: true };
    }
    const timeout = typeof args.timeout_ms === "number" ? args.timeout_ms : 60_000;
    if (ctx.signal?.aborted) return { output: "Command cancelled.", isError: true };
    // Lazy: execa costs ~250ms to import — load it on first shell use, not at startup.
    const { execa } = await import("execa");

    // Timeout/cancel must kill the whole process TREE, not just the shell:
    // with `shell: true` the direct child is cmd/sh, and an orphaned grandchild
    // keeps the output pipe open — so `await child` would hang forever (seen on
    // Windows) even after execa's own `timeout` fired. POSIX gets a process
    // group (detached) killed via -pid; Windows gets `taskkill /T /F`.
    const child = execa(command, {
      cwd: ctx.cwd,
      shell: true,
      reject: false,
      all: true,
      detached: process.platform !== "win32",
    });

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
      const status = result.exitCode === 0 ? "" : `\n[exit code ${result.exitCode}]`;
      return { output: `${out}${status}`.trim() || "(no output)", isError: result.exitCode !== 0 };
    } catch (err) {
      return { output: `Command failed: ${(err as Error).message}`, isError: true };
    } finally {
      clearTimeout(timer);
      ctx.signal?.removeEventListener("abort", onAbort);
    }
  },
};
