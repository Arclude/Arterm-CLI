import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Tool, ToolContext, ToolResult } from "@arterm/core";

const MAX_OUTPUT = 16 * 1024;

type Pm = "pnpm" | "yarn" | "npm";

interface ProjectScripts {
  pm: Pm;
  scripts: Record<string, string>;
  hasBiome: boolean;
}

/** Detect the package manager and available scripts from the working directory. */
export function detectScripts(cwd: string): ProjectScripts {
  let pm: Pm = "npm";
  if (existsSync(join(cwd, "pnpm-lock.yaml"))) pm = "pnpm";
  else if (existsSync(join(cwd, "yarn.lock"))) pm = "yarn";

  let scripts: Record<string, string> = {};
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    scripts = pkg.scripts ?? {};
  } catch {
    scripts = {};
  }
  const hasBiome = existsSync(join(cwd, "biome.json")) || existsSync(join(cwd, "biome.jsonc"));
  return { pm, scripts, hasBiome };
}

function truncate(s: string): string {
  return s.length > MAX_OUTPUT ? `${s.slice(0, MAX_OUTPUT)}\n…[truncated]` : s;
}

/** Run a command in the project, returning a ToolResult. */
async function runProjectCommand(
  file: string,
  args: string[],
  ctx: ToolContext,
): Promise<ToolResult> {
  try {
    // Lazy: execa is loaded on first project-command use, not at startup.
    const { execa } = await import("execa");
    const result = await execa(file, args, {
      cwd: ctx.cwd,
      shell: false,
      reject: false,
      all: true,
      ...(ctx.signal ? { cancelSignal: ctx.signal } : {}),
    });
    const out = truncate((result.all ?? `${result.stdout}\n${result.stderr}`).trim());
    const failed = result.exitCode !== 0;
    const status = failed ? `\n[exit code ${result.exitCode}]` : "";
    return { output: `${out}${status}`.trim() || "(no output)", isError: failed };
  } catch (err) {
    return { output: `Command failed: ${(err as Error).message}`, isError: true };
  }
}

/** `pnpm run <script>` / `npm run <script>` argument prefix for the detected PM. */
function runScript(pm: Pm, script: string, extra: string[]): string[] {
  // pnpm/yarn/npm all accept `run <script>`; npm needs `--` before script args.
  if (extra.length === 0) return ["run", script];
  return pm === "npm" ? ["run", script, "--", ...extra] : ["run", script, ...extra];
}

export const testTool: Tool = {
  name: "test",
  description:
    "Run the project's test suite (auto-detected from package.json). Optionally pass a " +
    "name `filter` or a `path` to narrow the run.",
  permission: "allow",
  category: "execute",
  riskTier: "caution",
  parameters: {
    type: "object",
    properties: {
      filter: { type: "string", description: "Test name pattern to pass through to the runner." },
      path: { type: "string", description: "Test file or directory to run." },
    },
  },
  preview: () => "run project tests",
  async execute(args, ctx) {
    const { pm, scripts } = detectScripts(ctx.cwd);
    if (!scripts.test) {
      return { output: "No `test` script found in package.json.", isError: true };
    }
    const extra: string[] = [];
    if (typeof args.path === "string" && args.path.trim()) extra.push(args.path.trim());
    if (typeof args.filter === "string" && args.filter.trim()) {
      extra.push("-t", args.filter.trim());
    }
    return runProjectCommand(pm, runScript(pm, "test", extra), ctx);
  },
};

export const lintTool: Tool = {
  name: "lint",
  description:
    "Run the project's linter/check (read-only — never applies fixes). Auto-detects a " +
    "`lint` script or Biome.",
  permission: "allow",
  category: "read",
  riskTier: "safe",
  parameters: { type: "object", properties: {} },
  preview: () => "run project lint",
  async execute(_args, ctx) {
    const { pm, scripts, hasBiome } = detectScripts(ctx.cwd);
    if (scripts.lint) return runProjectCommand(pm, runScript(pm, "lint", []), ctx);
    if (hasBiome) return runProjectCommand(pm, ["exec", "biome", "check", "."], ctx);
    return { output: "No `lint` script or Biome config found.", isError: true };
  },
};

export const formatTool: Tool = {
  name: "format",
  description:
    "Format the project's source in place (writes files). Auto-detects a `format` script " +
    "or Biome.",
  permission: "ask",
  category: "edit",
  mutating: true,
  riskTier: "caution",
  parameters: { type: "object", properties: {} },
  preview: () => "format project source (writes files)",
  async execute(_args, ctx) {
    const { pm, scripts, hasBiome } = detectScripts(ctx.cwd);
    if (scripts.format) return runProjectCommand(pm, runScript(pm, "format", []), ctx);
    if (hasBiome) return runProjectCommand(pm, ["exec", "biome", "format", "--write", "."], ctx);
    return { output: "No `format` script or Biome config found.", isError: true };
  },
};
