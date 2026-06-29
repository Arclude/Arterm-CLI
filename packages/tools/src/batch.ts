import type { Tool, ToolContext } from "@arterm/core";

/**
 * Meta-tool: run several tool calls in one step to cut round-trips (e.g. read
 * three files, or glob + grep + ls together). Dispatches against the live roster
 * from `ctx.tools`.
 *
 * SAFETY: only tools whose default permission is "allow" (read-only, never-prompt
 * tools) may run inside a batch. Anything that writes, edits, or runs commands
 * must be called on its own so it still passes through the permission prompt —
 * batch must never become a way to skip that gate. `batch` cannot nest.
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

/** Run one sub-call, enforcing the allow-only safety boundary. */
async function runOne(
  call: BatchCall,
  roster: readonly Tool[],
  ctx: ToolContext,
): Promise<{ name: string; output: string; isError: boolean }> {
  if (call.name === "batch") {
    return { name: call.name, output: "batch cannot be nested.", isError: true };
  }
  const tool = roster.find((t) => t.name === call.name);
  if (!tool) {
    return { name: call.name, output: `Unknown tool: ${call.name}`, isError: true };
  }
  if (tool.permission !== "allow") {
    return {
      name: call.name,
      output: `Refusing to batch "${call.name}": only read-only (allow) tools may run in a batch. Call it directly so it can be confirmed.`,
      isError: true,
    };
  }
  try {
    const result = await tool.execute(call.arguments ?? {}, ctx);
    return { name: call.name, output: result.output, isError: result.isError ?? false };
  } catch (err) {
    return { name: call.name, output: `Tool error: ${(err as Error).message}`, isError: true };
  }
}

export const batchTool: Tool = {
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
      ? await Promise.all(calls.map((c) => runOne(c, roster, ctx)))
      : await (async () => {
          const out: Awaited<ReturnType<typeof runOne>>[] = [];
          for (const c of calls) out.push(await runOne(c, roster, ctx));
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
