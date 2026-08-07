import type { Tool, ToolContext } from "@arterm/core";
import { type ToolUseGate, refuseStatically } from "./metaTools.js";

/**
 * Meta-tool: run several tool calls in one step to cut round-trips (e.g. read
 * three files, or glob + grep + ls together). Dispatches against the live roster
 * from `ctx.tools`.
 *
 * SAFETY. Dispatching to another tool's `execute` means the agent's
 * `toolCall.permission` stage already ran — for `batch`, not for what batch
 * runs. So either the ladder is re-entered for the inner call, or the inner
 * call is restricted to tools that would never have prompted anyway.
 *
 * This used to test `tool.permission !== "allow"` alone, and that let two real
 * things through:
 *
 *   - `permission` is the tool's DEFAULT, not its effective level.
 *     `PermissionManager.level()` is `overrides[name] ?? tool.permission`, so a
 *     user whose config says `{"permissions": {"web_fetch": "deny"}}` was obeyed
 *     for a direct call and ignored inside a batch — and CLAUDE.md's rule is
 *     that a hard tool-level deny wins in EVERY mode.
 *   - The mode was never consulted. `test` is `permission: "allow"` with
 *     `category: "execute"`; it runs whatever `package.json` says. A direct
 *     `test` call in PLAN mode is denied, and the same call inside a batch ran.
 *
 * The shared `refuseStatically` closes the second. The first cannot be closed
 * from inside a tool — `ToolContext` carries no permission handle — which is
 * what the injected `ToolUseGate` is for. `batch` cannot nest.
 */

interface BatchCall {
  name: string;
  arguments?: Record<string, unknown>;
}

/** Coerce the model-supplied `calls` array into validated BatchCall entries. */
function parseCalls(raw: unknown): BatchCall[] {
  if (!Array.isArray(raw)) {
    throw new Error("`calls` must be an array of { name, arguments } objects.");
  }
  return raw.map((entry, i) => {
    if (!entry || typeof entry !== "object") {
      throw new Error(`calls[${i}] must be an object.`);
    }
    const name = (entry as Record<string, unknown>).name;
    if (typeof name !== "string" || name.length === 0) {
      throw new Error(`calls[${i}].name must be a non-empty string.`);
    }
    const args = (entry as Record<string, unknown>).arguments;
    if (args !== undefined && (typeof args !== "object" || args === null || Array.isArray(args))) {
      throw new Error(`calls[${i}].arguments must be an object.`);
    }
    return { name, arguments: (args as Record<string, unknown>) ?? {} };
  });
}

/** Run one sub-call, enforcing the safety boundary above. */
async function runOne(
  call: BatchCall,
  roster: readonly Tool[],
  ctx: ToolContext,
  gate: ToolUseGate | undefined,
): Promise<{ name: string; output: string; isError: boolean }> {
  if (call.name === "batch") {
    return { name: call.name, output: "batch cannot be nested.", isError: true };
  }
  const tool = roster.find((t) => t.name === call.name);
  if (!tool) {
    return { name: call.name, output: `Unknown tool: ${call.name}`, isError: true };
  }
  // With a gate wired, the real ladder decides — mode, overrides, arbiter and
  // prompt, about the INNER tool. Without one, only tools that could never have
  // prompted are dispatchable.
  if (gate) {
    const verdict = await gate(tool, call.arguments ?? {});
    if (!verdict.allowed) {
      return {
        name: call.name,
        output: verdict.reason ?? `Refused: "${call.name}" was not permitted.`,
        isError: true,
      };
    }
  } else {
    const refusal = refuseStatically(tool, "batch");
    if (refusal) return { name: call.name, output: refusal, isError: true };
  }
  try {
    const result = await tool.execute(call.arguments ?? {}, ctx);
    return { name: call.name, output: result.output, isError: result.isError ?? false };
  } catch (err) {
    return { name: call.name, output: `Tool error: ${(err as Error).message}`, isError: true };
  }
}

/**
 * `batch`, optionally gated.
 *
 * A factory rather than a constant so the session can hand it the real ladder,
 * exactly as it does for `tool_use`. `batchTool` below is the ungated form the
 * registry and the tier tables use — strict-static, and correct on its own.
 */
export function createBatchTool(options: { gate?: ToolUseGate } = {}): Tool {
  const gate = options.gate;
  return {
    name: "batch",
    description:
      "Run several read-only tool calls in one step to save round-trips (e.g. read multiple " +
      "files, or glob + grep together). Only allow-listed read-only tools may be batched; " +
      "tools that write or run commands must be called individually.",
    permission: "allow",
    category: "read",
    parameters: {
      type: "object",
      properties: {
        calls: {
          type: "array",
          description: "The tool calls to run, each { name, arguments }.",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "Tool name to invoke." },
              arguments: { type: "object", description: "Arguments for that tool." },
            },
            required: ["name"],
          },
        },
        parallel: {
          type: "boolean",
          description: "Run the calls concurrently instead of in order (default false).",
        },
      },
      required: ["calls"],
    },
    preview: (args) => {
      const calls = Array.isArray(args.calls) ? args.calls : [];
      const names = calls
        .map((c) => (c && typeof c === "object" ? String((c as { name?: unknown }).name) : "?"))
        .join(", ");
      return `batch [${names}]`;
    },
    async execute(args, ctx) {
      let calls: BatchCall[];
      try {
        calls = parseCalls(args.calls);
      } catch (err) {
        return { output: (err as Error).message, isError: true };
      }
      if (calls.length === 0) {
        return { output: "batch received no calls.", isError: true };
      }
      const roster = ctx.tools ?? [];

      const results = args.parallel
        ? await Promise.all(calls.map((c) => runOne(c, roster, ctx, gate)))
        : await (async () => {
            const out: Awaited<ReturnType<typeof runOne>>[] = [];
            for (const c of calls) out.push(await runOne(c, roster, ctx, gate));
            return out;
          })();

      const anyError = results.some((r) => r.isError);
      const body = results
        .map((r, i) => {
          const tag = r.isError ? " (error)" : "";
          return `### [${i + 1}] ${r.name}${tag}\n${r.output}`;
        })
        .join("\n\n");
      return { output: body, isError: anyError };
    },
  };
}

/** The ungated form: strict-static, used by the registry and the tier tables. */
export const batchTool: Tool = createBatchTool();
