import {
  DEFAULT_HIDDEN_SUBAGENT_TOOLS,
  NEVER_SUBAGENT_TOOLS,
  type Tool,
  type ToolContext,
  clampMiddle,
  summarizeArgs,
} from "@arterm/core";
import { optionalString, requireString } from "./paths.js";
import type { WorkingDirStore } from "./workingDir.js";

/**
 * Meta-tools: the roster talking about itself.
 *
 * `tool_search` finds a tool by intent and `batch` runs several at once; these
 * three close the loop — read one tool's full guidance (`tool_help`), call a
 * tool the roster never advertised (`tool_use`), and move where the calls
 * resolve (`set_working_dir`).
 */

/**
 * Dispatchers that may not dispatch each other.
 *
 * Not a security boundary on its own — `batch` runs only read-only tools, so
 * `tool_use → batch` grants nothing extra today. It is a legibility rule: one
 * level of indirection is reviewable, and the gate that ran is the one for the
 * call you are reading. Two levels means the answer to "what was approved
 * here?" lives in another file.
 */
const META_DISPATCHERS = new Set(["tool_use", "batch"]);

/* -------------------------------------------------------------------------- */
/* Resolving a tool by name                                                    */
/* -------------------------------------------------------------------------- */

/**
 * What `tool_use` and `tool_help` may reach beyond what the model was shown.
 *
 * `defaultTools("full")` and nothing else. Everything a session builds by hand
 * — the fleet family, the memory tools, `task_done`, `submit_verdict`, MCP and
 * plugin tools — is scoped to one run or one session deliberately, and a
 * dispatcher that reached those would be handing out a terminal tool nobody
 * injected.
 *
 * Minus the names a worker is never given. `tool_use` cannot tell whether it
 * is running inside a sub-agent, and `subagentRoster()` filters the roster the
 * worker was HANDED — so anything reachable outside that roster walks around
 * the filter by construction. `git_commit` is the case that bites: it ships in
 * `defaultTools("standard")`, and it is withheld from workers precisely
 * because `--autonomous` would otherwise let one write to git history alone.
 * The strictest rule wins, because the looser one cannot be checked from here.
 */
let offRosterCache: Tool[] | undefined;

async function offRoster(): Promise<Tool[]> {
  if (!offRosterCache) {
    // Lazy: `registry.ts` imports this module, so a static import would be a
    // cycle. Deferring to call time also keeps the whole registry out of the
    // cost of loading a tool nobody called.
    const { defaultTools } = await import("./registry.js");
    offRosterCache = defaultTools("full").filter(
      (t) => !NEVER_SUBAGENT_TOOLS.has(t.name) && !DEFAULT_HIDDEN_SUBAGENT_TOOLS.has(t.name),
    );
  }
  return offRosterCache;
}

/** The live roster first — a session's own build of a tool wins over the registry's. */
async function findTool(name: string, ctx: ToolContext): Promise<Tool | undefined> {
  const onRoster = (ctx.tools ?? []).find((t) => t.name === name);
  if (onRoster) return onRoster;
  return (await offRoster()).find((t) => t.name === name);
}

/** Names close enough to be worth offering after a miss. */
function suggest(name: string, roster: readonly Tool[]): string {
  const needle = name.toLowerCase();
  const near = roster
    .map((t) => t.name)
    .filter((n) => n.includes(needle) || needle.includes(n))
    .slice(0, 5);
  return near.length > 0
    ? ` Did you mean: ${near.join(", ")}?`
    : " Use tool_search to find one by what you want to do.";
}

/* -------------------------------------------------------------------------- */
/* tool_help                                                                   */
/* -------------------------------------------------------------------------- */

/** One JSON-Schema property, as much of it as we render. */
interface PropSchema {
  type?: unknown;
  description?: unknown;
  enum?: unknown;
  items?: unknown;
  properties?: unknown;
}

function renderParams(parameters: Record<string, unknown>): string {
  const props = (parameters.properties ?? {}) as Record<string, unknown>;
  const required = new Set(
    Array.isArray(parameters.required) ? parameters.required.map((r) => String(r)) : [],
  );
  const names = Object.keys(props);
  if (names.length === 0) return "Parameters: none.";

  const lines = names.map((name) => {
    const spec = (props[name] ?? {}) as PropSchema;
    const type = typeof spec.type === "string" ? spec.type : "any";
    const req = required.has(name) ? ", required" : "";
    const desc = typeof spec.description === "string" ? ` ${spec.description}` : "";
    const choices = Array.isArray(spec.enum)
      ? ` One of: ${spec.enum.map((e) => String(e)).join(", ")}.`
      : "";
    // The nested shape is the part a rendered line cannot carry: "calls
    // (array, required): the tool calls to run" says nothing about what ONE
    // call looks like, and a guess costs a whole round-trip. So the sub-schema
    // goes in verbatim — and only for the properties that have one, because
    // dumping the whole schema is what made the roster expensive to begin with.
    const nested = spec.items ?? spec.properties;
    const shape = nested ? `\n    shape: ${JSON.stringify(nested)}` : "";
    return `  - ${name} (${type}${req}):${desc}${choices}${shape}`;
  });
  return `Parameters:\n${lines.join("\n")}`;
}

/**
 * The reader for `usageHint`.
 *
 * A tool's real guidance is deliberately kept out of the roster — the roster is
 * paid for on every request — and the agent delivers it attached to the tool's
 * first FAILED call. Which means a model that wants to use a tool WELL, before
 * failing with it, has no way to ask. This is that way to ask.
 */
export const toolHelpTool: Tool = {
  name: "tool_help",
  description:
    "Show one tool's full guidance: what it is for, how to use it well, when another tool is " +
    "the better answer, and its exact parameters. Works for tools that are not in your roster.",
  usageHint:
    "Call this BEFORE the first use of a tool you have not used in this session, not after it " +
    "fails. It also answers for tools you cannot see: the roster is trimmed for cost, and " +
    "anything it describes as off-roster can be run through tool_use.",
  permission: "allow",
  category: "read",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Exact tool name, e.g. 'grep'." },
    },
    required: ["name"],
  },
  preview: (args) => `tool_help ${String(args.name ?? "")}`,
  async execute(args, ctx) {
    const name = requireString(args, "name");
    const tool = await findTool(name, ctx);
    if (!tool) {
      return { output: `Unknown tool: ${name}.${suggest(name, ctx.tools ?? [])}`, isError: true };
    }

    const onRoster = (ctx.tools ?? []).some((t) => t.name === name);
    const parts: string[] = [
      `${tool.name} — ${tool.description}`,
      `permission: ${tool.permission} · category: ${tool.category ?? "execute"}${
        tool.riskTier ? ` · risk: ${tool.riskTier}` : ""
      }`,
    ];
    if (!onRoster) {
      parts.push("Not in your roster — call it through tool_use, not as a tool call of its own.");
    }
    if (tool.selection) {
      parts.push(
        `Do NOT use it when ${tool.selection.doNotUseWhen}; use ${tool.selection.useInstead} instead.`,
      );
    }
    // Said explicitly rather than omitted: silence reads as "the answer did not
    // arrive", and a model that thinks the guidance was lost asks again.
    parts.push(tool.usageHint ? `How to use it: ${tool.usageHint}` : "(no usage notes recorded)");
    parts.push(renderParams(tool.parameters));
    return { output: parts.join("\n") };
  },
};

/* -------------------------------------------------------------------------- */
/* tool_use                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The permission ladder, injected.
 *
 * Structurally satisfied by `(tool, args) => permissions.check(tool, args, ask)`
 * — which is the whole point: with this wired, `tool_use X` is gated by exactly
 * the rules that gate a direct call to X, prompt included, and the prompt is
 * about X rather than about `tool_use`.
 */
export type ToolUseGate = (
  tool: Tool,
  args: Record<string, unknown>,
) => Promise<{ allowed: boolean; reason?: string }>;

export interface ToolUseOptions {
  /** When absent, dispatch is restricted to tools that can never prompt. */
  gate?: ToolUseGate;
}

/**
 * What may be dispatched with no gate wired: tools that never prompt AND never
 * mutate — read-only in both senses.
 *
 * `batch` tests only `permission === "allow"`, and that is not enough. Two
 * holes follow from it, both real today:
 *
 *   - `permission` is the tool's DEFAULT, not the effective level.
 *     `PermissionManager.level()` is `overrides[name] ?? tool.permission`, so a
 *     user whose config says `{"permissions": {"web_fetch": "deny"}}` is obeyed
 *     for a direct call and ignored inside a batch.
 *   - The mode is not consulted at all. `test` is `permission: "allow"` with
 *     `category: "execute"`: it runs the project's test script, which is
 *     whatever `package.json` says. A direct `test` call in PLAN mode is denied
 *     (`category !== "read"`); the same call inside a batch runs.
 *
 * The category check below closes the second for `tool_use`. The first cannot
 * be closed from inside a tool — `ToolContext` carries no permission handle —
 * which is what `ToolUseGate` is for.
 */
export function refuseStatically(tool: Tool, dispatcher = "tool_use"): string | undefined {
  if (tool.permission !== "allow") {
    return `"${tool.name}" needs permission (${tool.permission}), and ${dispatcher} has no way to ask for it. Only read-only tools may be dispatched. Call it directly so the prompt is about the tool that actually runs.`;
  }
  // The same default `PermissionManager.category()` applies: a tool that
  // declares nothing is treated as "execute", never as read-only.
  const category = tool.category ?? "execute";
  if (category !== "read") {
    return `"${tool.name}" is an ${category} tool, and only read-only tools may be dispatched through ${dispatcher}. Call it directly so the session's permission mode applies to it.`;
  }
  return undefined;
}

/**
 * Call a tool by name — including one the roster never advertised.
 *
 * The roster is a fixed tax on every request (see `ToolTier`), so a tier holds
 * back tools that are occasionally exactly what is needed. This reaches them
 * for the price of one name instead of every schema.
 *
 * The safety seam is the whole design. Dispatching to another tool's `execute`
 * means the agent's `toolCall.permission` stage already ran — for `tool_use`,
 * not for what `tool_use` runs. So either a gate re-enters the real ladder for
 * the inner call, or the inner call is restricted to tools that would never
 * have prompted anyway. There is no third option where the model picks.
 */
export function createToolUseTool(options: ToolUseOptions = {}): Tool {
  return {
    name: "tool_use",
    description:
      "Call another tool by name, including tools that are not in your roster. Use it for a " +
      "tool tool_search or tool_help told you about but that you cannot see.",
    usageHint:
      "Pass the inner tool's arguments as an object under `arguments`, exactly as that tool's " +
      "schema describes them — call tool_help first if you are unsure. Tools that prompt or " +
      "change files are refused here on purpose: call those directly, by name.",
    permission: "allow",
    category: "read",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "The tool to run, e.g. 'code_stats'." },
        arguments: { type: "object", description: "That tool's arguments, as its schema wants." },
      },
      required: ["name"],
    },
    preview: (args) => {
      const inner = args.arguments;
      const shown =
        inner && typeof inner === "object" && !Array.isArray(inner)
          ? JSON.stringify(summarizeArgs(inner as Record<string, unknown>))
          : "{}";
      return `tool_use ${String(args.name ?? "?")} ${shown}`;
    },
    async execute(args, ctx) {
      const name = requireString(args, "name");
      const raw = args.arguments;
      if (raw !== undefined && (typeof raw !== "object" || raw === null || Array.isArray(raw))) {
        return { output: "`arguments` must be an object.", isError: true };
      }
      const innerArgs = (raw as Record<string, unknown>) ?? {};

      if (META_DISPATCHERS.has(name)) {
        return {
          output: `tool_use cannot dispatch "${name}" — call the tool you actually want.`,
          isError: true,
        };
      }
      const tool = await findTool(name, ctx);
      if (!tool) {
        return { output: `Unknown tool: ${name}.${suggest(name, ctx.tools ?? [])}`, isError: true };
      }

      if (options.gate) {
        // The gate IS the ladder — mode, overrides, arbiter and prompt. It runs
        // for read-only tools too, because a per-tool "deny" override is a
        // decision about the tool, not about how it was reached.
        const decision = await options.gate(tool, innerArgs);
        if (!decision.allowed) {
          return { output: decision.reason ?? `Denied: ${name}`, isError: true };
        }
      } else {
        const refusal = refuseStatically(tool);
        if (refusal) return { output: refusal, isError: true };
      }

      try {
        const result = await tool.execute(innerArgs, ctx);
        return {
          output: `[${name}]\n${clip(tool, result.output)}`,
          isError: result.isError ?? false,
          // Forwarded so a change made through here still reaches the changed-
          // files summary and the transcript's diff. A gated `tool_use edit`
          // that showed up nowhere would be an edit nobody could review.
          ...(result.diff ? { diff: result.diff } : {}),
          ...(result.path ? { path: result.path } : {}),
        };
      } catch (err) {
        // A throwing inner tool is reported, never rethrown: rethrowing would
        // be indistinguishable from `tool_use` itself being broken.
        const msg = err instanceof Error ? err.message : String(err);
        return { output: `Tool error in ${name}: ${msg}`, isError: true };
      }
    },
  };
}

/**
 * Apply the INNER tool's output ceiling.
 *
 * The agent clamps against the tool it dispatched — `tool_use` — so a tool that
 * declares a deliberately small `maxOutputBytes` would silently get the 200 KiB
 * backstop instead, purely because of how it was reached. The number belongs to
 * the tool's author either way.
 */
function clip(tool: Tool, output: string): string {
  if (tool.maxOutputBytes === undefined) return output;
  const clamped = clampMiddle(output, tool.maxOutputBytes);
  return clamped.truncated
    ? `${clamped.text}\n[clipped to ${tool.name}'s ${tool.maxOutputBytes}-byte ceiling (was ${clamped.originalBytes}) — narrow the arguments for the rest]`
    : clamped.text;
}

/** The registry's build: no gate, so dispatch is read-only tools only. */
export const toolUseTool: Tool = createToolUseTool();

/* -------------------------------------------------------------------------- */
/* set_working_dir                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Move where relative paths resolve, within the session root.
 *
 * `permission: "ask"` is the one deliberate cost here, and it is not about this
 * call — the store refuses anything outside the root, so nothing new becomes
 * reachable. It is about the NEXT call: after a move, a permission prompt
 * reading `write index.ts` means a different file than it did a moment ago,
 * and the prompt has no way to say so. A move is a once-or-twice-a-session
 * call, so the user sees it once and every later prompt keeps its meaning.
 *
 * `category: "read"` is honest beside it: this writes nothing to disk, and
 * narrowing the directory is exactly what plan-mode exploration wants.
 */
export function createSetWorkingDirTool(store: WorkingDirStore): Tool {
  return {
    name: "set_working_dir",
    description:
      "Change the directory that later tool calls resolve relative paths against. It must stay " +
      "inside the session root; pass reset: true to go back to the root.",
    usageHint:
      "Use it when a task lives entirely in one subtree — move once, then use short paths. " +
      "After a move, every relative path you write means something different, so say where you " +
      "are when it matters. The root is fixed at startup and cannot be widened from here.",
    permission: "ask",
    category: "read",
    mutating: false,
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Directory to move to, relative to the current one (or absolute).",
        },
        reset: { type: "boolean", description: "Return to the session root; ignores `path`." },
      },
    },
    preview: (args) =>
      args.reset === true
        ? "set_working_dir (back to the root)"
        : `set_working_dir ${String(args.path ?? "?")}`,
    async execute(args) {
      const reset = args.reset === true;
      const path = optionalString(args, "path");
      if (!reset && !path) {
        return {
          output: "Pass `path` (a directory inside the session root) or `reset: true`.",
          isError: true,
        };
      }
      const change = reset ? store.reset() : store.set(path as string);
      if (!change.ok) {
        return { output: change.error ?? "The working directory was not changed.", isError: true };
      }
      // Both forms, every time: the relative one is how the model will think
      // about its next path, the absolute one is what it can hand to a human.
      return {
        output:
          `Working directory is now ${store.relative()} (${change.dir}). Relative paths in ` +
          `later tool calls resolve here. The session root (${store.root}) is unchanged.`,
      };
    },
  };
}
