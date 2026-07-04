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

/**
 * Truly destructive shell commands — denied outright. Covers both POSIX shells
 * and Windows cmd/PowerShell, because the `bash` tool runs with `shell: true`
 * (so on Windows the command reaches cmd.exe/PowerShell). Windows patterns are
 * case-insensitive; they target whole-drive / system-root wipes only.
 */
const CRITICAL_BASH: RegExp[] = [
  /rm\s+-[rf]{1,2}\s+\/(?:\s|$)/,
  /rm\s+-[rf]{1,2}\s+~(?:\/\s|\s|$)/,
  /\bmkfs\b/,
  /\bdd\b[^\n]*\bof=\/dev\//,
  /:\s*\(\s*\)\s*\{[^}]*\}\s*;/,
  /--no-preserve-root/,
  />\s*\/dev\/sd[a-z]/,
  // Windows — irreversible whole-disk / system-root destruction.
  /\bformat\b[^\n]{0,40}\b[a-z]:(?:\\|\s|"|$)/i,
  /\bformat-volume\b/i,
  /\bclear-disk\b/i,
  /\bcipher\b[^\n]*\/w[:\s]/i,
  /\b(?:rd|rmdir|del)\b[^\n]*?\/s\b[^\n]*?\b[a-z]:\\?(?:\s|"|\*|$)/i,
  /\bremove-item\b[^\n]*?-recurse\b[^\n]*?\b[a-z]:\\?(?:\s|"|$)/i,
  /\b(?:rd|rmdir|del|remove-item)\b[^\n]*?(?:\/s\b|-recurse\b)[^\n]*?(?:%SystemDrive%|%SystemRoot%|%WinDir%|\$env:SystemRoot|\$env:windir)/i,
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
  // Windows — recursive deletes, privilege escalation, remote exec, system tampering.
  /\bremove-item\b[^\n]*-recurse\b/i,
  /\b(?:rd|rmdir)\b[^\n]*\/s\b/i,
  /\bdel\b[^\n]*\/s\b/i,
  /\brunas\b/i,
  /\bstart-process\b[^\n]*-verb\s+runas/i,
  /(?:downloadstring|invoke-webrequest|iwr|wget|curl)\b[^\n]*\|\s*(?:iex|invoke-expression)/i,
  /\b(?:iex|invoke-expression)\b[^\n]*(?:downloadstring|invoke-webrequest|iwr|http)/i,
  /\bset-executionpolicy\b/i,
  /\breg\b\s+delete\b/i,
  /\bbcdedit\b/i,
  /\btakeown\b/i,
  /\bicacls\b[^\n]*\/grant/i,
  /\bnet\b\s+(?:user|localgroup)\b[^\n]*\/add\b/i,
  /\bsc\b\s+delete\b/i,
  /\bdiskpart\b/i,
  /\bvssadmin\b[^\n]*\bdelete\b/i,
  /\bwevtutil\b[^\n]*\bcl\b/i,
  /\bset-mppreference\b[^\n]*-disablerealtimemonitoring/i,
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
