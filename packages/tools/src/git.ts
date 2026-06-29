import type { Tool } from "@arterm/core";
import { execa } from "execa";
import { requireString, resolveWithin } from "./paths.js";

const MAX_OUTPUT = 16 * 1024;

/** Read-only git subcommands and their safe base argument lists. */
const READ_SUBCOMMANDS: Record<string, string[]> = {
  status: ["status", "--porcelain=v1", "-b"],
  diff: ["diff"],
  log: ["log", "--oneline", "-n", "20"],
  show: ["show"],
  branch: ["branch", "--list"],
};

/**
 * Flags refused on the read-only `git` tool: they can run arbitrary code or
 * reconfigure git into a mutation. The base subcommands above are all read-only,
 * but free-form `args` could otherwise smuggle one of these in.
 */
const BLOCKED_FLAG = /^(-c|--exec|--exec-path|--upload-pack|--receive-pack|-o|--output|-O)/;

function truncate(s: string): string {
  return s.length > MAX_OUTPUT ? `${s.slice(0, MAX_OUTPUT)}\n…[truncated]` : s;
}

async function runGit(args: string[], cwd: string, signal?: AbortSignal) {
  const result = await execa("git", args, {
    cwd,
    shell: false,
    reject: false,
    all: true,
    ...(signal ? { cancelSignal: signal } : {}),
  });
  const out = truncate((result.all ?? `${result.stdout}\n${result.stderr}`).trim());
  const failed = result.exitCode !== 0;
  const status = failed ? `\n[exit code ${result.exitCode}]` : "";
  return { output: `${out}${status}`.trim() || "(no output)", isError: failed };
}

export const gitTool: Tool = {
  name: "git",
  description:
    "Run a read-only git command (status, diff, log, show, branch) in the working " +
    "directory. Use git_commit to record changes.",
  permission: "allow",
  category: "read",
  riskTier: "safe",
  parameters: {
    type: "object",
    properties: {
      subcommand: {
        type: "string",
        enum: Object.keys(READ_SUBCOMMANDS),
        description: "Which read-only git command to run.",
      },
      args: {
        type: "string",
        description: "Extra arguments (e.g. a path or ref). Mutating flags are rejected.",
      },
    },
    required: ["subcommand"],
  },
  preview: (args) => `git ${String(args.subcommand)} ${String(args.args ?? "")}`.trim(),
  async execute(args, ctx) {
    const sub = requireString(args, "subcommand");
    const base = READ_SUBCOMMANDS[sub];
    if (!base) {
      return { output: `Unknown or non-read-only subcommand: ${sub}`, isError: true };
    }
    const extra =
      typeof args.args === "string" && args.args.trim() ? args.args.trim().split(/\s+/) : [];
    const bad = extra.find((a) => BLOCKED_FLAG.test(a));
    if (bad) {
      return { output: `Refused argument on read-only git: ${bad}`, isError: true };
    }
    return runGit([...base, ...extra], ctx.cwd, ctx.signal);
  },
};

export const gitCommitTool: Tool = {
  name: "git_commit",
  description:
    "Stage changes and create a git commit in the working directory. Set `all` to " +
    "stage every change, or pass specific `paths`.",
  permission: "ask",
  category: "edit",
  mutating: true,
  riskTier: "caution",
  parameters: {
    type: "object",
    properties: {
      message: { type: "string", description: "Commit message." },
      all: { type: "boolean", description: "Stage all changes (git add -A) before committing." },
      paths: {
        type: "array",
        items: { type: "string" },
        description: "Specific paths to stage (relative to the working directory).",
      },
    },
    required: ["message"],
  },
  preview: (args) => `git commit -m "${String(args.message).slice(0, 60)}"`,
  async execute(args, ctx) {
    const message = requireString(args, "message");
    const paths = Array.isArray(args.paths) ? args.paths.filter((p) => typeof p === "string") : [];

    if (args.all === true || paths.length === 0) {
      const add = await runGit(["add", "-A"], ctx.cwd, ctx.signal);
      if (add.isError) return add;
    } else {
      for (const p of paths) {
        try {
          resolveWithin(ctx.cwd, p as string);
        } catch (err) {
          return { output: (err as Error).message, isError: true };
        }
      }
      const add = await runGit(["add", "--", ...(paths as string[])], ctx.cwd, ctx.signal);
      if (add.isError) return add;
    }

    return runGit(["commit", "-m", message], ctx.cwd, ctx.signal);
  },
};
