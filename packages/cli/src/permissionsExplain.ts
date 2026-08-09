import { join } from "node:path";
import {
  ARTERM_HOME,
  type ArtermConfig,
  type PermissionEvaluation,
  type PermissionMode,
  type Tool,
  brainArbiterModel,
  createPermissionManager,
  loadConfig,
} from "@arterm/core";
import { McpManager, PluginLoader, defaultTools } from "@arterm/tools";
import { ArtermUserError } from "./errors.js";

/**
 * `arterm permissions explain` — answer "what would happen if the agent called
 * this tool?" without calling it.
 *
 * The value is that it runs the real policy: the same `createPermissionManager`
 * a session builds and the same `evaluate()` the agent loop consults, so the
 * answer can't be a plausible-looking guess. Nothing is executed and no
 * override is written — the tool never sees the arguments.
 */

export interface ExplainOptions {
  /** Tool name, as the model would call it. */
  tool: string;
  /** JSON object of tool arguments — the arbiter classifies risk from these. */
  args?: string;
  /** Evaluate under a different mode than the configured one. */
  mode?: string;
  /**
   * Evaluate as an unattended run (`--autonomous`, headless `--print`).
   *
   * The explainer has to offer this because the ladder's answer now depends on
   * it: a command that reads a credential store is a PROMPT with someone there
   * and a REFUSAL without. Without the flag the inspector would describe the
   * attended policy for the run people are least able to watch, which is the
   * one failure `permissions explain` exists to prevent.
   */
  unattended?: boolean;
  json?: boolean;
  /** Skip MCP/plugin tools (faster; no servers are started). */
  builtinsOnly?: boolean;
}

export interface ExplainResult {
  tool: string;
  args: Record<string, unknown>;
  evaluation: PermissionEvaluation;
  /** Set when a model-based gate would run before this policy. */
  brainArbiterModel?: string;
  /** Where the tool came from, since a plugin tool's default is not obvious. */
  source: "built-in" | "mcp" | "plugin";
}

const MODES: PermissionMode[] = ["ask", "auto", "plan", "yolo"];

export function parseArgs(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`--args is not valid JSON: ${(err as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error('--args must be a JSON object, e.g. \'{"command":"ls"}\'');
  }
  return parsed as Record<string, unknown>;
}

export function parseMode(raw: string | undefined): PermissionMode | undefined {
  if (!raw) return undefined;
  if (!MODES.includes(raw as PermissionMode)) {
    throw new Error(`unknown mode "${raw}" — expected one of: ${MODES.join(", ")}`);
  }
  return raw as PermissionMode;
}

/** Evaluate one proposed call against the policy built from `config`. */
export function explainCall(
  config: ArtermConfig,
  tools: Array<{ tool: Tool; source: ExplainResult["source"] }>,
  opts: {
    tool: string;
    args: Record<string, unknown>;
    mode?: PermissionMode;
    unattended?: boolean;
  },
): ExplainResult {
  const entry = tools.find((t) => t.tool.name === opts.tool);
  if (!entry) {
    const names = tools
      .map((t) => t.tool.name)
      .sort()
      .join(", ");
    throw new Error(`unknown tool "${opts.tool}". Available: ${names}`);
  }
  const permissions = createPermissionManager(config, {
    ...(opts.mode ? { mode: opts.mode } : {}),
    ...(opts.unattended ? { unattended: true } : {}),
  });
  const model = brainArbiterModel(config);
  return {
    tool: entry.tool.name,
    args: opts.args,
    evaluation: permissions.evaluate(entry.tool, opts.args),
    ...(model ? { brainArbiterModel: model } : {}),
    source: entry.source,
  };
}

const OUTCOME_GLYPH: Record<PermissionEvaluation["outcome"], string> = {
  allow: "✓ runs without asking",
  deny: "✗ blocked",
  prompt: "? prompts you first",
};

/** Human-readable trace. The last step is the one that decided. */
export function formatExplanation(result: ExplainResult): string {
  const { evaluation: e } = result;
  const lines: string[] = [];

  lines.push(`${result.tool}  →  ${OUTCOME_GLYPH[e.outcome]}`);
  if (e.reason) lines.push(`  ${e.reason}`);
  lines.push("");
  lines.push(
    `  mode: ${e.mode}   category: ${e.category}   level: ${e.level}${
      e.overridden ? " (override)" : ""
    }${e.riskTier ? `   risk: ${e.riskTier}` : ""}   source: ${result.source}`,
  );
  lines.push("");
  for (const step of e.trace) {
    lines.push(`  ${step.decided ? "▸" : "·"} ${step.rule.padEnd(20)} ${step.detail}`);
  }

  if (result.brainArbiterModel) {
    lines.push("");
    lines.push(
      `  note: the model gate "${result.brainArbiterModel}" runs BEFORE this policy and can only block.`,
    );
    lines.push("        It is not evaluated here — doing so would cost a provider call.");
  }
  return lines.join("\n");
}

/**
 * Collect the tool surface a session would have. MCP and plugin tools are
 * included by default because an unfamiliar third-party tool is exactly the one
 * worth asking about; `--builtins-only` skips starting those servers.
 */
export async function collectTools(
  config: ArtermConfig,
  builtinsOnly: boolean,
): Promise<Array<{ tool: Tool; source: ExplainResult["source"] }>> {
  // The session's tier, not the default one. `buildSession` builds the roster
  // from `config.tools.tier`; an inspector that always listed `standard` would
  // describe a surface nobody runs — hiding `install` from a `full` session's
  // table, and inventing rows a `minimal` session does not have.
  const entries: Array<{ tool: Tool; source: ExplainResult["source"] }> = defaultTools(
    config.tools?.tier,
  ).map((tool) => ({ tool, source: "built-in" as const }));
  if (builtinsOnly) return entries;

  const seen = new Set(entries.map((e) => e.tool.name));
  const mcp = new McpManager(config.mcpServers);
  const pluginTrust = Object.fromEntries(
    Object.entries(config.plugins ?? {}).map(([name, p]) => [name, p.trust]),
  );
  const plugins = new PluginLoader(join(ARTERM_HOME, "plugins"), pluginTrust);
  const [mcpTools, pluginTools] = await Promise.all([mcp.connect(), plugins.load()]);
  for (const tool of mcpTools) {
    if (!seen.has(tool.name)) entries.push({ tool, source: "mcp" });
  }
  for (const tool of pluginTools) {
    if (!seen.has(tool.name)) entries.push({ tool, source: "plugin" });
  }
  await mcp.close();
  return entries;
}

/**
 * Command entry point. Exits non-zero when the call would be blocked, so this is
 * usable as a check in a script ("would this be allowed under my config?").
 */
export async function runPermissionsExplain(opts: ExplainOptions): Promise<void> {
  const args = parseArgs(opts.args);
  const mode = parseMode(opts.mode);
  const config = await loadConfig();
  const tools = await collectTools(config, opts.builtinsOnly === true);

  let result: ExplainResult;
  try {
    result = explainCall(config, tools, {
      tool: opts.tool,
      args,
      ...(mode ? { mode } : {}),
      ...(opts.unattended ? { unattended: true } : {}),
    });
  } catch (err) {
    throw new ArtermUserError((err as Error).message);
  }

  process.stdout.write(
    opts.json ? `${JSON.stringify(result, null, 2)}\n` : `${formatExplanation(result)}\n`,
  );
  if (result.evaluation.outcome === "deny") process.exitCode = 1;
}
