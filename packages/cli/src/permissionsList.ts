import {
  type ArtermConfig,
  type PermissionEvaluation,
  type PermissionMode,
  type Tool,
  brainArbiterModel,
  createPermissionManager,
  loadConfig,
} from "@arterm/core";
import { ArtermUserError } from "./errors.js";
import { type ExplainResult, collectTools, parseMode } from "./permissionsExplain.js";

/**
 * `arterm permissions list` — the whole tool surface at a glance, with what the
 * policy resolves to for each one.
 *
 * `explain` answers "what happens to *this* call?". This answers the question
 * that comes first: "what can this agent do to my machine at all?" Both run the
 * same `evaluate()` a session runs, so the table is the policy, not a summary of
 * it.
 *
 * The honest limitation, stated in the output rather than hidden: every row is
 * evaluated with **empty arguments**. The arbiter classifies risk from the
 * arguments, so an execute tool's real outcome depends on the command — the row
 * shows what the ladder decides before anything is known about the call. Use
 * `permissions explain <tool> --args …` for a specific one.
 */

export interface ListOptions {
  /** Evaluate under a different mode than the configured one. */
  mode?: string;
  json?: boolean;
  /** Skip MCP/plugin tools (faster; no servers are started). */
  builtinsOnly?: boolean;
  /** Show only rows with this outcome. */
  only?: string;
}

export interface ListRow {
  tool: string;
  source: ExplainResult["source"];
  category: string;
  /** Effective level after overrides — what the tool's own default resolved to. */
  level: string;
  /** True when the level came from config rather than the tool's default. */
  overridden: boolean;
  riskTier?: string;
  outcome: PermissionEvaluation["outcome"];
  /** Why, when a rule had something to say. */
  reason?: string;
  /**
   * True when the arbiter judges this tool from its arguments, so {@link outcome}
   * is the answer for a call we know nothing about — a `bash` row can read "runs"
   * and still deny `rm -rf /`. Without this the table is uniformly reassuring in
   * `auto` mode, which is exactly the mode where the distinction matters.
   */
  argDependent: boolean;
}

export interface ListResult {
  mode: PermissionMode;
  rows: ListRow[];
  /** Tools evaluated, before `--only` filtering — so a filtered table says so. */
  total: number;
  /** Set when a model-based gate would run before this policy. */
  brainArbiterModel?: string;
  /** True when an arbiter screens command arguments (rows can't show its per-call verdict). */
  arbiterScreensArgs: boolean;
}

const OUTCOMES: PermissionEvaluation["outcome"][] = ["allow", "deny", "prompt"];

export function parseOnly(raw: string | undefined): PermissionEvaluation["outcome"] | undefined {
  if (!raw) return undefined;
  if (!OUTCOMES.includes(raw as PermissionEvaluation["outcome"])) {
    throw new Error(`unknown outcome "${raw}" — expected one of: ${OUTCOMES.join(", ")}`);
  }
  return raw as PermissionEvaluation["outcome"];
}

/** Evaluate every tool against the policy built from `config`. */
export function listPermissions(
  config: ArtermConfig,
  tools: Array<{ tool: Tool; source: ExplainResult["source"] }>,
  opts: { mode?: PermissionMode; only?: PermissionEvaluation["outcome"] } = {},
): ListResult {
  const permissions = createPermissionManager(config, {
    ...(opts.mode ? { mode: opts.mode } : {}),
  });
  const model = brainArbiterModel(config);

  // The arbiter reads `args` only for mutating categories: a command's regexes,
  // an edit's path. Read tools are always "low", so their row is the final word.
  const arbiterOn = config.arbiter?.enabled !== false;

  const rows: ListRow[] = [];
  for (const { tool, source } of tools) {
    const e = permissions.evaluate(tool, {});
    if (opts.only && e.outcome !== opts.only) continue;
    rows.push({
      tool: tool.name,
      source,
      category: e.category,
      level: e.level,
      overridden: e.overridden,
      ...(e.riskTier ? { riskTier: e.riskTier } : {}),
      outcome: e.outcome,
      ...(e.reason ? { reason: e.reason } : {}),
      argDependent: arbiterOn && e.outcome !== "deny" && e.category !== "read",
    });
  }

  // Riskiest first, then alphabetical — the rows worth reading are at the top.
  const rank: Record<PermissionEvaluation["outcome"], number> = { allow: 0, prompt: 1, deny: 2 };
  rows.sort((a, b) => rank[b.outcome] - rank[a.outcome] || a.tool.localeCompare(b.tool));

  return {
    mode: permissions.getMode(),
    rows,
    total: tools.length,
    ...(model ? { brainArbiterModel: model } : {}),
    arbiterScreensArgs: arbiterOn,
  };
}

const OUTCOME_GLYPH: Record<PermissionEvaluation["outcome"], string> = {
  allow: "✓ runs",
  deny: "✗ blocked",
  prompt: "? prompts",
};

/** The outcome cell, with `*` marking a verdict the arguments can still change. */
function outcomeCell(row: ListRow): string {
  return `${OUTCOME_GLYPH[row.outcome]}${row.argDependent ? "*" : ""}`;
}

/** Fixed-width table; the widths come from the data so nothing wraps needlessly. */
export function formatList(result: ListResult): string {
  if (result.rows.length === 0) return "No tools match.";

  const nameWidth = Math.max(4, ...result.rows.map((r) => r.tool.length));
  const outcomeWidth = Math.max(...result.rows.map((r) => outcomeCell(r).length));
  const lines: string[] = [];

  const shown =
    result.rows.length === result.total
      ? `${result.total} tools`
      : `${result.rows.length} of ${result.total} tools`;
  lines.push(`mode: ${result.mode}   ${shown}`);
  lines.push("");
  for (const row of result.rows) {
    const flags = [
      row.overridden ? "override" : "",
      row.riskTier ? `risk:${row.riskTier}` : "",
      row.source !== "built-in" ? row.source : "",
    ].filter(Boolean);
    lines.push(
      (
        `  ${outcomeCell(row).padEnd(outcomeWidth)}  ${row.tool.padEnd(nameWidth)}  ` +
        `${row.category.padEnd(7)} ${row.level.padEnd(5)}${flags.length ? `  ${flags.join(" ")}` : ""}`
      ).trimEnd(),
    );
  }

  // Each note is one paragraph; its continuation lines align under the label.
  const notes: string[][] = [];
  if (result.rows.some((r) => r.argDependent)) {
    notes.push([
      "* the arbiter judges these from the actual arguments, and every row here was",
      "  evaluated with none — a `runs*` tool can still be escalated or denied per call",
      "  (`rm -rf /` never runs). `arterm permissions explain <tool> --args '{…}'` for one.",
    ]);
  }
  if (result.brainArbiterModel) {
    notes.push([
      `The model gate "${result.brainArbiterModel}" runs BEFORE this policy and can only block.`,
      "It is not evaluated here — doing so would cost a provider call per tool.",
    ]);
  }
  for (const note of notes) {
    lines.push("");
    note.forEach((line, i) => lines.push(i === 0 ? `  note: ${line}` : `        ${line}`));
  }
  return lines.join("\n");
}

/** Command entry point. Always exits 0 — this is an inventory, not a check. */
export async function runPermissionsList(opts: ListOptions): Promise<void> {
  let mode: PermissionMode | undefined;
  let only: PermissionEvaluation["outcome"] | undefined;
  try {
    mode = parseMode(opts.mode);
    only = parseOnly(opts.only);
  } catch (err) {
    throw new ArtermUserError((err as Error).message);
  }

  const config = await loadConfig();
  const tools = await collectTools(config, opts.builtinsOnly === true);
  const result = listPermissions(config, tools, {
    ...(mode ? { mode } : {}),
    ...(only ? { only } : {}),
  });

  process.stdout.write(
    opts.json ? `${JSON.stringify(result, null, 2)}\n` : `${formatList(result)}\n`,
  );
}
