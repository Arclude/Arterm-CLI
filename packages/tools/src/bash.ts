import type { Tool } from "@arterm/core";
import { execa } from "execa";
import { requireString } from "./paths.js";

/** Obvious-footgun patterns that are refused even with permission. */
const DENY = [/\brm\s+-rf\s+\/(?:\s|$)/, /\bmkfs\b/, /\bdd\s+if=/, /:\(\)\s*\{.*\};:/];

export const bashTool: Tool = {
  name: "bash",
  description:
    "Run a shell command in the working directory and return combined stdout/stderr. " +
    "Uses the system shell. Prefer dedicated tools (read/edit/glob) when they fit.",
  permission: "ask",
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
        signal: ctx.signal,
      });
      const out = result.all ?? `${result.stdout}\n${result.stderr}`;
      const status = result.exitCode === 0 ? "" : `\n[exit code ${result.exitCode}]`;
      return { output: `${out}${status}`.trim() || "(no output)", isError: result.exitCode !== 0 };
    } catch (err) {
      return { output: `Command failed: ${(err as Error).message}`, isError: true };
    }
  },
};
