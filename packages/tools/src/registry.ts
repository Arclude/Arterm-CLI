import { type Tool, estimateTokens } from "@arterm/core";
import { bashTool } from "./bash.js";
import { batchTool } from "./batch.js";
import { calleesTool, callersTool, codeStatsTool, deadCodeTool } from "./codebase.js";
import { diffTool } from "./diff.js";
import { editTool } from "./edit.js";
import { createExecTool } from "./exec.js";
import { gitCommitTool, gitTool } from "./git.js";
import { globTool } from "./glob.js";
import { grepTool } from "./grep.js";
import { jsonTool } from "./json.js";
import { logsTool } from "./logs.js";
import { lsTool } from "./ls.js";
import { lspTools } from "./lsp/tools.js";
import { multiEditTool } from "./multiEdit.js";
import { patchTool } from "./patch.js";
import {
  auditTool,
  formatTool,
  installTool,
  lintTool,
  outdatedTool,
  testTool,
  typecheckTool,
} from "./project.js";
import { readTool } from "./read.js";
import { replaceTool } from "./replace.js";
import { searchTool } from "./search.js";
import { submitVerdictTool } from "./submitVerdict.js";
import { symbolsTool } from "./symbols.js";
import { taskDoneTool } from "./taskDone.js";
import { toolSearchTool } from "./toolSearch.js";
import { treeTool } from "./tree.js";
import { webFetchTool } from "./webFetch.js";
import { webSearchTool } from "./webSearch.js";
import { writeTool } from "./write.js";

/**
 * How much of the roster to hand the model.
 *
 * Every tool's name, description and JSON schema is sent on EVERY request, so
 * the roster is a fixed tax on the whole session. A tool nobody calls still
 * costs its schema in every turn — and a bigger roster is not only more
 * expensive, it is harder to choose from.
 *
 * - `minimal` — what it takes to read, change and run code. For a small local
 *   model, where the roster competes with the actual context.
 * - `standard` — the default: everything a normal coding turn reaches for.
 * - `full` — everything registered.
 */
export type ToolTier = "minimal" | "standard" | "full";

/** Read, change, run — nothing else. */
const MINIMAL: Tool[] = [readTool, grepTool, globTool, writeTool, editTool, bashTool];

/** Added at `standard`: the rest of an ordinary coding turn. */
const STANDARD_EXTRA: Tool[] = [
  lsTool,
  treeTool,
  searchTool,
  symbolsTool,
  multiEditTool,
  patchTool,
  replaceTool,
  jsonTool,
  diffTool,
  gitTool,
  gitCommitTool,
  testTool,
  lintTool,
  formatTool,
  typecheckTool,
  webFetchTool,
  webSearchTool,
];

/**
 * Added at `full`: package management, operations, and the meta-tools.
 *
 * The meta-tools go last on purpose — both describe or dispatch OTHER tools, so
 * they are worth their schema only once the roster is large enough to be worth
 * searching. On a six-tool roster, `tool_search` costs more than it saves.
 *
 * `install`, `audit` and `outdated` sit here rather than at `standard` because
 * an ordinary coding turn does not manage dependencies: it reads, changes and
 * runs code. A session that needs them is doing a different job, and can say so.
 */
const FULL_EXTRA: Tool[] = [
  callersTool,
  calleesTool,
  deadCodeTool,
  codeStatsTool,
  installTool,
  auditTool,
  outdatedTool,
  logsTool,
  ...lspTools,
  toolSearchTool,
  batchTool,
];

/** The default tool set wired into the agent. */
export function defaultTools(tier: ToolTier = "standard"): Tool[] {
  if (tier === "minimal") return [...MINIMAL];
  if (tier === "standard") return [...MINIMAL, ...STANDARD_EXTRA];
  return [...MINIMAL, ...STANDARD_EXTRA, ...FULL_EXTRA];
}

/**
 * What one tool costs to advertise, in tokens: the name, the description, the
 * selection hint and the whole parameter schema, which is what actually goes
 * on the wire. `usageHint` is excluded because it is not sent with the roster.
 */
export function toolSchemaTokens(tool: Tool): number {
  const wire = JSON.stringify({
    name: tool.name,
    description: tool.description,
    selection: tool.selection,
    parameters: tool.parameters,
  });
  return estimateTokens(wire);
}

/** Per-tool and total schema cost for a tier — the measurement behind the tiers. */
export function tierCost(tier: ToolTier): {
  tools: { name: string; tokens: number }[];
  total: number;
} {
  const tools = defaultTools(tier)
    .map((t) => ({ name: t.name, tokens: toolSchemaTokens(t) }))
    .sort((a, b) => b.tokens - a.tokens);
  return { tools, total: tools.reduce((sum, t) => sum + t.tokens, 0) };
}

// taskDoneTool and submitVerdictTool are intentionally NOT in defaultTools — both
// are injected as a run's terminal tool (a goal's, a review's) rather than being
// ambient, which also keeps them off the `permissions list` / `explain` surface.
export {
  readTool,
  lsTool,
  treeTool,
  globTool,
  grepTool,
  searchTool,
  symbolsTool,
  writeTool,
  editTool,
  multiEditTool,
  patchTool,
  replaceTool,
  jsonTool,
  diffTool,
  bashTool,
  webFetchTool,
  webSearchTool,
  gitTool,
  gitCommitTool,
  testTool,
  lintTool,
  formatTool,
  typecheckTool,
  installTool,
  auditTool,
  outdatedTool,
  logsTool,
  callersTool,
  calleesTool,
  deadCodeTool,
  codeStatsTool,
  toolSearchTool,
  batchTool,
  taskDoneTool,
  submitVerdictTool,
};
