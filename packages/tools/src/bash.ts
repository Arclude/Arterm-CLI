import type { Tool } from "@arterm/core";
import { execa } from "execa";
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
];

export const bashTool: Tool = {
  name: "bash",
  description:
    "Run a shell command in the working directory and return combined stdout/stderr. " +
    "Uses the system shell. Prefer dedicated tools (read/edit/glob) when they fit.",
  permission: "ask",
  category: "execute",
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

    try {
      const result = await execa(command, {
        cwd: ctx.cwd,
        shell: true,
        timeout,
        reject: false,
        all: true,
        // execa v9 renamed `signal` → `cancelSignal`.
        ...(ctx.signal ? { cancelSignal: ctx.signal } : {}),
      });
      const out = result.all ?? `${result.stdout}\n${result.stderr}`;
      const status = result.exitCode === 0 ? "" : `\n[exit code ${result.exitCode}]`;
      return { output: `${out}${status}`.trim() || "(no output)", isError: result.exitCode !== 0 };
    } catch (err) {
      return { output: `Command failed: ${(err as Error).message}`, isError: true };
    }
  },
};
