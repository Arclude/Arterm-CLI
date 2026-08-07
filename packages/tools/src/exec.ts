/**
 * Running a program without a shell.
 *
 * `bash` hands a string to `sh -c`, which is what makes
 * `echo cm0gLXJmIC8K | base64 -d | sh` possible: the string the shell finally
 * executes does not exist until after the pipe, so no pattern over the original
 * command can see it. `OPAQUE_BASH` grades the HIDING rather than the payload
 * precisely because the payload is unknowable there.
 *
 * `exec` removes the shell. argv goes to the process directly, so a pipe is the
 * literal characters `|` in an argument and a `$(…)` is a dollar sign — there is
 * nothing to interpret them. That is the whole of what this tool buys, and it
 * is worth being exact about what it does NOT buy: `exec("node", ["-e", "…"])`
 * still hands an interpreter a program. The arbiter sees the joined argv (see
 * `inspectable`), so that call is graded exactly as its `bash` equivalent would
 * be.
 *
 * The allowlist is the second layer, and a modest one: it bounds WHICH programs
 * may start, so a freshly downloaded `./payload` cannot. It cannot stop an
 * allowed interpreter being handed code, and pretending otherwise would be the
 * kind of claim that stops people reading the rest.
 */

import { basename } from "node:path";
import type { Tool, ToolContext, ToolResult } from "@arterm/core";
import { type ProcessRegistry, scrubEnv, withheldNote } from "@arterm/core";

import { startBackground, startedNote } from "./background.js";
import { shJoin } from "./shellQuote.js";

/**
 * Programs `exec` may start.
 *
 * A development toolchain, not a general-purpose shell. Shells and shell-like
 * dispatchers are deliberately absent — `sh`, `bash`, `zsh`, `env`, `xargs`,
 * `nohup`, `setsid`, `script`, `ssh` — because every one of them is a way to
 * run something that is not on this list, which would make the list decoration.
 * Someone who needs them has `bash`, where the permission ladder and the
 * arbiter are already looking.
 */
const DEFAULT_ALLOWED = [
  // JS/TS
  "node",
  "npm",
  "npx",
  "pnpm",
  "pnpx",
  "yarn",
  "bun",
  "bunx",
  "deno",
  "tsc",
  "tsx",
  "ts-node",
  "vitest",
  "jest",
  "mocha",
  "playwright",
  "eslint",
  "biome",
  "prettier",
  "rollup",
  "vite",
  "esbuild",
  "webpack",
  "tsup",
  // Python
  "python",
  "python3",
  "pip",
  "pip3",
  "pytest",
  "ruff",
  "black",
  "mypy",
  "poetry",
  "uv",
  // Rust
  "cargo",
  "rustc",
  "rustup",
  "rustfmt",
  "clippy-driver",
  // Go
  "go",
  "gofmt",
  "golangci-lint",
  // JVM / .NET / others
  "java",
  "javac",
  "mvn",
  "gradle",
  "kotlin",
  "dotnet",
  "swift",
  "ruby",
  "bundle",
  "rake",
  "php",
  "composer",
  "elixir",
  "mix",
  "dart",
  "flutter",
  // Build and VCS
  "make",
  "cmake",
  "ninja",
  "bazel",
  "just",
  "git",
  "hg",
  "svn",
  // Read-only inspection
  "ls",
  "cat",
  "head",
  "tail",
  "wc",
  "file",
  "stat",
  "du",
  "df",
  "grep",
  "rg",
  "ag",
  "fd",
  "find",
  "sort",
  "uniq",
  "cut",
  "tr",
  "diff",
  "jq",
  "yq",
  "which",
  "uname",
  "date",
  "echo",
  "printf",
  "true",
  "false",
] as const;

/** The allowlist for a session: the defaults plus whatever config added. */
export function allowedCommands(extra?: readonly string[]): Set<string> {
  return new Set<string>([...DEFAULT_ALLOWED, ...(extra ?? [])]);
}

export interface ExecToolOptions {
  registry: ProcessRegistry;
  /**
   * Extra command names, from `exec.allow` in config.
   *
   * This must only ever come from the USER's config. Today it does by
   * construction — `loadConfig` reads `~/.arterm/config.json` and nothing else,
   * and `config.trustedOnly.test.ts` fails if that stops being true. The rule is
   * the sandbox's, written down here because this is the second place it
   * applies: a boundary a repository can widen by committing a file is not a
   * boundary, and a cloned repo whose `.arterm/config.json` added `sh` to this
   * list would have removed the only thing the list does.
   */
  extraAllowed?: readonly string[];
}

/** Bytes of a foreground command's output kept in the result. */
const MAX_OUTPUT_BYTES = 32_768;

export function createExecTool(opts: ExecToolOptions): Tool {
  return {
    name: "exec",
    maxOutputBytes: MAX_OUTPUT_BYTES,
    description:
      "Run a program directly, without a shell — arguments are passed as-is, so no quoting, " +
      "globbing, piping or redirection happens. Set `background` to start it and return at once.",
    usageHint:
      "Prefer this to `bash` whenever you are running one program: nothing reinterprets your " +
      "arguments, so a path with a space or a regex with a `$` in it arrives intact and needs no " +
      "escaping. Reach for `bash` when you actually want the shell — a pipeline, a redirect, a " +
      "glob. `background` is for something that does not end on its own (a dev server, a watcher); " +
      "the process gets an id, and `/ps` lists and stops it. Everything started this way is killed " +
      "when the session closes.",
    permission: "ask",
    category: "execute",
    mutating: true,
    riskTier: "destructive",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Program to run (no shell)." },
        args: {
          type: "array",
          items: { type: "string" },
          description: "Arguments, passed through untouched.",
        },
        timeout_ms: { type: "number", description: "Timeout in ms (default 60000)." },
        background: {
          type: "boolean",
          description: "Start it and return an id instead of waiting.",
        },
      },
      required: ["command"],
    },
    preview: (args) => {
      const argv = [String(args.command ?? ""), ...asArgs(args.args)];
      return `${args.background === true ? "exec (background)" : "exec"}: ${shJoin(argv)}`;
    },
    async execute(args, ctx) {
      const command = typeof args.command === "string" ? args.command.trim() : "";
      if (!command) return { output: "`command` is required.", isError: true };
      const argv = asArgs(args.args);

      // Matched on the BASENAME, so `/usr/bin/node` and `node` are one entry —
      // but a path is still refused below, because allowing one means the
      // allowlist is about the last path segment of anything on disk.
      const allowed = allowedCommands(opts.extraAllowed);
      if (command.includes("/") || command.includes("\\")) {
        return {
          output: `exec takes a program NAME, not a path (${command}). Use \`bash\` to run something by path.`,
          isError: true,
        };
      }
      if (!allowed.has(basename(command))) {
        const where =
          "Run it with `bash` (where the arbiter and the permission prompt see the whole " +
          "command), or add it to `exec.allow` in ~/.arterm/config.json.";
        return { output: `\`${command}\` is not in exec's allowlist. ${where}`, isError: true };
      }

      return args.background === true
        ? runBackground(command, argv, ctx, opts.registry)
        : runForeground(
            command,
            argv,
            ctx,
            typeof args.timeout_ms === "number" ? args.timeout_ms : 60_000,
          );
    },
  };
}

function asArgs(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((a): a is string => typeof a === "string") : [];
}

/** The sandbox seam: the wrapper takes a command string, so argv is quoted once. */
async function wrap(
  command: string,
  argv: string[],
  ctx: ToolContext,
): Promise<{ argv: string[]; env: Record<string, string | undefined> } | undefined | ToolResult> {
  if (!ctx.sandbox) return undefined;
  try {
    return await ctx.sandbox.wrap(shJoin([command, ...argv]), ctx.cwd, ctx.signal);
  } catch (err) {
    return {
      output: `Sandbox refused the command: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
    };
  }
}

async function runForeground(
  command: string,
  argv: string[],
  ctx: ToolContext,
  timeoutMs: number,
): Promise<ToolResult> {
  const sandboxed = await wrap(command, argv, ctx);
  if (sandboxed && "output" in sandboxed) return sandboxed;
  const { env, withheld } = scrubEnv(
    { ...process.env, ...(sandboxed?.env ?? {}) },
    ctx.credentials,
  );

  try {
    const { execa } = await import("execa");
    const spawn = sandboxed?.argv ?? [command, ...argv];
    const result = await execa(spawn[0] as string, spawn.slice(1), {
      cwd: ctx.cwd,
      // Never `shell: true`. That would undo the only thing this tool does.
      shell: false,
      reject: false,
      all: true,
      env,
      extendEnv: false,
      timeout: timeoutMs,
      ...(ctx.signal ? { cancelSignal: ctx.signal } : {}),
    });
    const out = (result.all ?? `${result.stdout}\n${result.stderr}`).trim();
    if (result.timedOut) {
      return { output: `${out}\n[timed out after ${timeoutMs}ms]`.trim(), isError: true };
    }
    if (result.exitCode === 0) return { output: out || "(no output)" };
    const note = withheldNote(withheld, `${command} ${argv.join(" ")}\n${out}`);
    return {
      output: `${out}\n[exit code ${result.exitCode}]${note ? `\n${note}` : ""}`.trim(),
      isError: true,
    };
  } catch (err) {
    return {
      output: `exec failed: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
    };
  } finally {
    ctx.sandbox?.release();
  }
}

async function runBackground(
  command: string,
  argv: string[],
  ctx: ToolContext,
  registry: ProcessRegistry,
): Promise<ToolResult> {
  const sandboxed = await wrap(command, argv, ctx);
  if (sandboxed && "output" in sandboxed) return sandboxed;
  try {
    const record = await startBackground(
      {
        spawn: sandboxed?.argv ?? [command, ...argv],
        // What is RECORDED is the user's argv, not the sandbox wrapper's — a
        // `/ps` row reading `bwrap --ro-bind … node server.js` names the
        // boundary rather than the process.
        label: [command, ...argv],
        ...(sandboxed?.env ? { env: sandboxed.env } : {}),
      },
      ctx,
      registry,
    );
    return { output: startedNote(record) };
  } catch (err) {
    return {
      output: `exec failed to start: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
    };
  } finally {
    ctx.sandbox?.release();
  }
}
