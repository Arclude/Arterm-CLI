import type { PermissionMode } from "./permissions.js";
import type { Tool, ToolCategory } from "./types.js";

/**
 * The Brain Arbiter classifies the risk of an individual tool CALL (from its
 * arguments, not just the tool type) and decides how to handle it: auto-allow,
 * deny outright, escalate to the human, or defer to the normal mode policy.
 */

export type RiskLevel = "low" | "medium" | "high" | "critical";

export interface RiskAssessment {
  level: RiskLevel;
  reason?: string;
}

/** Truly destructive shell commands — denied outright. */
const CRITICAL_BASH: RegExp[] = [
  /rm\s+-[rf]{1,2}\s+\/(?:\s|$)/,
  /rm\s+-[rf]{1,2}\s+~(?:\/\s|\s|$)/,
  /\bmkfs\b/,
  /\bdd\b[^\n]*\bof=\/dev\//,
  /:\s*\(\s*\)\s*\{[^}]*\}\s*;/,
  /--no-preserve-root/,
  />\s*\/dev\/sd[a-z]/,
];

/** Risky-but-sometimes-legitimate commands — escalated to the human. */
const HIGH_BASH: RegExp[] = [
  /\brm\s+-[rf]{1,2}\b/,
  /\bsudo\b/,
  /git\s+push\b[^\n]*(--force|-f)\b/,
  /git\s+reset\s+--hard\b/,
  /\bchmod\s+(-R\s+)?777\b/,
  /\bcurl\b[^|\n]*\|\s*(sh|bash)\b/,
  /\bwget\b[^|\n]*\|\s*(sh|bash)\b/,
  /\bnpm\s+publish\b/,
  /\bkill(all)?\b\s+-9\b/,
  />\s*\/etc\//,
];

/** Paths whose edits warrant a human look (secrets, keys, git internals). */
const SENSITIVE_PATH = /(^|\/)(\.env|\.git\/|id_rsa|\.ssh\/|secrets?\.|credentials)/i;

const RANK: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2, critical: 3 };

/** Raise an assessment to at least `floor`, keeping the more specific reason. */
function atLeast(a: RiskAssessment, floor: RiskLevel, reason: string): RiskAssessment {
  return RANK[a.level] >= RANK[floor] ? a : { level: floor, reason: a.reason ?? reason };
}

/** Heuristically assess how risky a specific tool call is. Pure + testable. */
export function assessRisk(tool: Tool, args: Record<string, unknown>): RiskAssessment {
  const category: ToolCategory = tool.category ?? "execute";
  const base = assessByArgs(tool, args, category);
  // A destructive-tier tool is floored at "high" even when its args look benign —
  // but NOT for shell/execute tools, whose real risk is already judged from the
  // actual command above (CRITICAL_BASH / HIGH_BASH). Blanket-bumping every command
  // would escalate even `ls`, so routine commands could never run without a prompt.
  // This way `rm -rf` / `sudo` stay caught while safe commands pass through as-is.
  if (tool.riskTier === "destructive" && category !== "execute") {
    return atLeast(base, "high", `destructive tool: ${tool.name}`);
  }
  return base;
}

function assessByArgs(
  tool: Tool,
  args: Record<string, unknown>,
  category: ToolCategory,
): RiskAssessment {
  if (category === "read") return { level: "low" };

  if (category === "execute") {
    const cmd = typeof args.command === "string" ? args.command : JSON.stringify(args);
    for (const re of CRITICAL_BASH) {
      if (re.test(cmd))
        return { level: "critical", reason: `destructive command: ${cmd.slice(0, 60)}` };
    }
    for (const re of HIGH_BASH) {
      if (re.test(cmd)) return { level: "high", reason: `risky command: ${cmd.slice(0, 60)}` };
    }
    return { level: "medium" };
  }

  // edit
  const path = typeof args.path === "string" ? args.path : "";
  if (SENSITIVE_PATH.test(path)) {
    return { level: "high", reason: `edits a sensitive file: ${path}` };
  }
  return { level: "medium" };
}

export type ArbiterDecision = "allow" | "deny" | "escalate" | "default";

export interface ArbiterContext {
  mode: PermissionMode;
  category: ToolCategory;
}

export interface ToolArbiter {
  decide(
    tool: Tool,
    args: Record<string, unknown>,
    ctx: ArbiterContext,
  ): { decision: ArbiterDecision; reason?: string };
}

/**
 * Risk-based arbiter: deny critical-risk calls, escalate high-risk calls to the
 * human (even in auto mode), and defer everything else to the normal mode policy.
 */
export class RiskArbiter implements ToolArbiter {
  decide(
    tool: Tool,
    args: Record<string, unknown>,
    _ctx?: ArbiterContext,
  ): { decision: ArbiterDecision; reason?: string } {
    const risk = assessRisk(tool, args);
    if (risk.level === "critical") {
      return {
        decision: "deny",
        reason: `blocked by arbiter (critical risk): ${risk.reason ?? ""}`,
      };
    }
    if (risk.level === "high") {
      return { decision: "escalate", reason: risk.reason };
    }
    return { decision: "default" };
  }
}
