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

/**
 * Commands that would kill the agent running them.
 *
 * A pattern-matched `pkill -f node` reads as ordinary process cleanup, and on
 * a machine where the agent IS a node process it ends the session mid-turn:
 * the run stops with no summary, no verdict, and no checkpoint — the user
 * simply loses the work. `kill -9 -1` and its Windows equivalents are the same
 * shape.
 *
 * Graded `critical` rather than `high`, i.e. denied even under yolo, because
 * unlike the other criticals this one is not about the damage — it is that the
 * process which would ask the follow-up question is the one being killed. An
 * agent cannot recover from, report on, or be steered away from its own death.
 * A user who genuinely wants these can run them in their own shell.
 */
const SELF_KILL_BASH: RegExp[] = [
  // Kill every process the user owns, or every process at all.
  /\bkill(?:all)?\s+(?:-\w+\s+)*-1\b/,
  /\bpkill\s+(?:-\w+\s+)*-(?:1|u\s+\$?\w+)\b/,
  // Match-by-name kills that necessarily include this process.
  /\b(?:pkill|killall)\b[^\n]*\b(?:node|bun|deno|arterm|electron)\b/i,
  // PowerShell / Windows equivalents.
  /\bstop-process\b[^\n]*-name\s+["']?(?:node|arterm|electron)/i,
  /\btaskkill\b[^\n]*\/im\s+["']?(?:node|arterm|electron)\.exe/i,
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

/**
 * Commands that assemble themselves at runtime — graded on the fact that they
 * cannot be read.
 *
 * Every list above it is a deny-list, and a deny-list fails OPEN by
 * construction: what it does not recognize, it grades `medium`, and `medium`
 * runs without a prompt under `auto` and `yolo`. `echo cm0gLXJmIC8K | base64 -d
 * | sh` is `rm -rf /` that no pattern here will ever match, because the string
 * the shell finally executes does not exist until after the pipe.
 *
 * So this list does not try to guess what the hidden command is. It matches the
 * HIDING — decode-then-execute, fetch-then-execute, `eval` of a substitution,
 * an interpreter handed a base64 blob — and grades it `high`, which is the
 * closed answer: attended sessions get a prompt, and every unattended caller
 * (sub-agents via `subagentPolicy`, the headless broker's default asker)
 * answers an escalation with "deny". An analyzer that cannot see what runs
 * should say so rather than return "medium" and mean "I found nothing".
 *
 * Deliberately `high` and not `critical`: `eval "$(direnv hook zsh)"` and
 * `eval "$(ssh-agent)"` are real things developers run, and a flat refusal for
 * everyone would be paid by the people whose shells work that way. A prompt is
 * the honest handling of "unreadable", a block is the honest handling of
 * "readable and destructive" — which is what CRITICAL_BASH already covers.
 *
 * The documented hole: hiding SPLIT ACROSS COMMANDS — `curl … > /tmp/x` in one
 * call and `sh /tmp/x` in the next — is not here and cannot be. Each half reads
 * as ordinary on its own, the two can sit turns apart, and a rule wide enough to
 * catch them fires on `wget deps.tar && python3 setup.py`. What bounds that case
 * is the sandbox's egress allowlist, not a pattern.
 */
const OPAQUE_BASH: RegExp[] = [
  // decode → interpreter (the classic; `|` may be preceded by more pipeline)
  /\b(?:base64|b64decode|uudecode|xxd|basenc)\b[^\n]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|dash|ksh|python[0-9.]*|perl|ruby|node|php)\b/i,
  /\bopenssl\b[^\n]*\benc\b[^\n]*(?:-d|-decrypt)\b[^\n]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|dash)\b/i,
  // eval of a substitution or of a variable — the body is unknown until it runs
  /\beval\b[^\n]*(?:\$\(|`)/,
  /\beval\b\s+["']?\$\{?[A-Za-z_]/,
  // an interpreter invoked ON a substitution: sh -c "$(curl …)", bash <(…)
  /\b(?:sh|bash|zsh|dash|ksh)\b\s+-c\s*["']?\s*\$\(/,
  /\b(?:sh|bash|zsh|ksh)\b\s*<\s*\(/,
  // python/node handed source they build themselves
  /\bpython[0-9.]*\b[^\n]*-c\b[^\n]*\b(?:exec|eval|b64decode|marshal\.loads|codecs\.decode)\s*\(/i,
  /\bnode\b[^\n]*-e\b[^\n]*\b(?:eval|Function|from\(\s*["']?[A-Za-z0-9+/=]{16,})/,
  // PowerShell -EncodedCommand (and its abbreviations) with a base64 payload
  /(?:^|\s)-e(?:nc|ncoded|ncodedcommand)?\s+["']?[A-Za-z0-9+/=]{24,}/i,
  /\b(?:frombase64string|invoke-expression|iex)\b/i,
  // word-splitting tricks whose only purpose is to break a literal apart
  /\$\{IFS\}/,
  /\$\{[A-Za-z_][A-Za-z0-9_]*:\d+:\d+\}/,
];

/** Paths whose edits warrant a human look (secrets, keys, git internals). */
const SENSITIVE_PATH = /(^|\/)(\.env|\.git\/|id_rsa|\.ssh\/|secrets?\.|credentials)/i;

/**
 * Arterm's OWN key material, named by a command.
 *
 * `credentials.ts` withholds credential-named variables from what a command
 * INHERITS, and its reasoning is that the leak needs no egress: `env` puts them
 * in the transcript, which goes to the provider, to the session JSONL, into
 * fleet prompts and into every later compaction. `cat ~/.arterm/key
 * ~/.arterm/secrets.json` is the same leak by a different door, and a worse
 * one — it yields the keys `arterm auth set` stored, which were never in the
 * environment for the scrub to withhold.
 *
 * `critical`, so it is refused in every mode including yolo, and this is the
 * one place that grade is not an over-reaction. `critical` elsewhere means
 * readable and destructive; here it means there is no legitimate call at all —
 * `arterm auth` manages these files, and no compiler, test runner or `git`
 * opens them. A `high` prompt would be a question with one correct answer, and
 * under `--autonomous` it would not even be asked (yolo returns allow on an
 * escalation; only a critical verdict blocks).
 *
 * A text screen sees the spelling, not the file — `.arterm/*` in a glob, or a
 * path assembled from a variable, walks past it. That half is the sandbox's
 * `denyRead`, which is enforced on the inode however the command spells it.
 * Neither is redundant: the sandbox is off by default for attended sessions,
 * which is exactly where this list is the only control.
 */
const OWN_KEYSTORE_READ =
  /(?:\.arterm|\$\{?ARTERM_HOME\}?)[/\\](?:key\b|secrets\.json\b)|(?:\.arterm|ARTERM_HOME)[/\\]\*/i;

/**
 * Credential stores this machine holds for OTHER tools.
 *
 * `high`, not `critical`: `ssh-add ~/.ssh/id_ed25519` and reading `~/.npmrc` to
 * debug a registry 401 are things a developer legitimately asks for, so a
 * prompt is the honest handling — the same line `OPAQUE_BASH` draws between
 * "unreadable" and "readable and destructive". They are not ours to declare
 * pointless the way the entry above is.
 *
 * The cost of that choice is stated rather than hidden: `high` escalates, and
 * yolo allows an escalation, so an `--autonomous` run can read these. What
 * bounds it there is the egress allowlist plus the fact that the transcript is
 * the user's own; what would not bound it is grading everything critical until
 * people turn the arbiter off.
 */
const THIRD_PARTY_CREDENTIAL_READ = [
  /(?:^|[\s"'=])[~/][^\s"']*\.ssh[/\\]id_[a-z0-9_]+(?!\.pub)\b/i,
  /\.aws[/\\]credentials\b/i,
  /(?:^|[\s"'=/])\.netrc\b/i,
  /\.docker[/\\]config\.json\b/i,
  /\.kube[/\\]config\b/i,
  /(?:^|[\s"'=/])\.npmrc\b/i,
  /(?:^|[\s"'=/])\.pypirc\b/i,
  /\.config[/\\]gh[/\\]hosts\.ya?ml\b/i,
  /\.config[/\\]gcloud[/\\][^\s"']*credential/i,
  /(?:^|[\s"'=/])\.gnupg[/\\]/i,
];

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

/**
 * The text every command pattern is matched against.
 *
 * `bash` puts the whole command in `command`. `exec` splits it: `{command:
 * "node", args: ["-e", "…"]}`. Reading only `command` would grade that call as
 * the word "node" — so `exec` would become the bypass for the exact control it
 * was added to improve on, since `OPAQUE_BASH` would never see the payload.
 *
 * Joining argv with spaces OVER-approximates: `exec("echo", ["rm -rf /"])` now
 * reads as the dangerous command it merely quotes. That is the safe direction
 * to be wrong in a deny-list — a refused `echo` costs a sentence, and the
 * opposite error costs the machine.
 */
function inspectable(args: Record<string, unknown>): string {
  const parts: string[] = [];
  if (typeof args.command === "string") parts.push(args.command);
  if (Array.isArray(args.args)) {
    for (const a of args.args) if (typeof a === "string") parts.push(a);
  }
  return parts.length > 0 ? parts.join(" ") : JSON.stringify(args);
}

function assessByArgs(
  tool: Tool,
  args: Record<string, unknown>,
  category: ToolCategory,
): RiskAssessment {
  if (category === "read") return { level: "low" };

  if (category === "execute") {
    const cmd = inspectable(args);
    for (const re of CRITICAL_BASH) {
      if (re.test(cmd))
        return { level: "critical", reason: `destructive command: ${cmd.slice(0, 60)}` };
    }
    for (const re of SELF_KILL_BASH) {
      if (re.test(cmd)) {
        return {
          level: "critical",
          reason: `this would kill the agent's own process: ${cmd.slice(0, 60)}`,
        };
      }
    }
    if (OWN_KEYSTORE_READ.test(cmd)) {
      return {
        level: "critical",
        reason: `this reads Arterm's own key material: ${cmd.slice(0, 60)}`,
      };
    }
    for (const re of HIGH_BASH) {
      if (re.test(cmd)) return { level: "high", reason: `risky command: ${cmd.slice(0, 60)}` };
    }
    for (const re of THIRD_PARTY_CREDENTIAL_READ) {
      if (re.test(cmd)) {
        return {
          level: "high",
          reason: `this reads a credential store: ${cmd.slice(0, 60)}`,
        };
      }
    }
    for (const re of OPAQUE_BASH) {
      if (re.test(cmd)) {
        return {
          level: "high",
          reason: `command builds itself at runtime, so it cannot be screened: ${cmd.slice(0, 60)}`,
        };
      }
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
