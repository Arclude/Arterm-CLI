import type { ArbiterDecision, ToolArbiter } from "./arbiter.js";
import type { PermissionAsker, PermissionLevel, Tool, ToolCategory } from "./types.js";

/**
 * Session permission mode (cycle with Shift+Tab in the TUI):
 *   - "ask":  prompt before edit/execute tools (the default).
 *   - "auto": auto-approve file edits and arbiter-screened safe shell commands;
 *             risky commands (rm -rf, sudo, force-push…) still prompt, critical ones
 *             are denied. Without an arbiter, execute tools still prompt.
 *   - "plan": read-only — block every edit/execute tool, no prompts.
 *   - "yolo": approve everything without prompts, BUT stay fail-closed —
 *             a tool-level deny and an arbiter "critical" verdict still block.
 */
export type PermissionMode = "ask" | "auto" | "plan" | "yolo";

export const PERMISSION_MODES: PermissionMode[] = ["ask", "auto", "plan", "yolo"];

export interface PermissionDecision {
  allowed: boolean;
  /** True when the user chose "always" — caller should persist it. */
  persist: boolean;
  /** Set when blocked by the mode (not the user), e.g. plan mode. */
  reason?: string;
}

/** What the policy resolves to before any human is involved. */
export type PermissionOutcome = "allow" | "deny" | "prompt";

/** One rule the policy consulted, in the order it ran. */
export interface PermissionTraceStep {
  /** Rule id — stable enough to match on (`tool-level`, `arbiter`, `mode:plan`, …). */
  rule: string;
  /** What that rule saw, in words. */
  detail: string;
  /** True on the single step that produced the outcome. */
  decided: boolean;
}

/**
 * The full reasoning behind a decision: the inputs the policy saw, every rule it
 * consulted, and where it stopped. Produced by {@link PermissionManager.evaluate}
 * — the same function `check()` runs — so an explanation can never drift from the
 * behavior it describes.
 */
export interface PermissionEvaluation {
  outcome: PermissionOutcome;
  /** Present when a rule blocked the call and had something to say about it. */
  reason?: string;
  mode: PermissionMode;
  category: ToolCategory;
  /** Effective level after overrides — what the tool's own default resolved to. */
  level: PermissionLevel;
  /** True when the level came from an override rather than the tool's default. */
  overridden: boolean;
  riskTier?: string;
  trace: PermissionTraceStep[];
}

/**
 * Resolves whether a tool call may run, consulting (in order):
 *   1. the session permission mode (yolo / plan / auto)
 *   2. per-tool overrides (from config / "always allow")
 *   3. the tool's own default permission
 * When the effective level is "ask" (and the mode doesn't pre-decide), the
 * supplied asker is invoked.
 */
export class PermissionManager {
  private overrides: Record<string, PermissionLevel>;
  private mode: PermissionMode;
  private readonly arbiter?: ToolArbiter;
  /** When true, tools tagged `riskTier: "destructive"` always re-prompt, even in auto/yolo. */
  private confirmDestructive: boolean;
  /**
   * Nobody is at the keyboard. Passed to the arbiter, which is the only layer
   * that knows WHY a call was escalated — and an escalation is a question, so
   * the answer depends on whether anyone is there to answer it. Defaults to
   * false, so a manager built without this (a test, a standalone call) behaves
   * exactly as it did.
   */
  private readonly unattended: boolean;

  constructor(
    overrides: Record<string, PermissionLevel> = {},
    mode: PermissionMode = "ask",
    arbiter?: ToolArbiter,
    confirmDestructive = false,
    unattended = false,
  ) {
    this.overrides = { ...overrides };
    this.mode = mode;
    this.arbiter = arbiter;
    this.confirmDestructive = confirmDestructive;
    this.unattended = unattended;
  }

  getMode(): PermissionMode {
    return this.mode;
  }

  setMode(mode: PermissionMode): void {
    this.mode = mode;
  }

  setConfirmDestructive(on: boolean): void {
    this.confirmDestructive = on;
  }

  /** Current effective level for a tool, ignoring the mode. */
  level(tool: Tool): PermissionLevel {
    return this.overrides[tool.name] ?? tool.permission;
  }

  private category(tool: Tool): ToolCategory {
    return tool.category ?? "execute";
  }

  /**
   * Run the policy ladder without involving a human and report what it found.
   *
   * This IS the decision — `check()` calls it and only adds the prompt when the
   * outcome is "prompt". An explainer (`arterm permissions explain`) can
   * therefore show exactly what would happen without executing anything, and
   * cannot fall out of sync with the real behavior.
   *
   * Side-effect free: the arbiter's `decide` is a pure classifier, and nothing
   * here touches overrides (only answering a prompt does).
   */
  evaluate(tool: Tool, args: Record<string, unknown>): PermissionEvaluation {
    const category = this.category(tool);
    const level = this.level(tool);
    const trace: PermissionTraceStep[] = [];
    const base: Omit<PermissionEvaluation, "outcome" | "reason"> = {
      mode: this.mode,
      category,
      level,
      overridden: this.overrides[tool.name] !== undefined,
      ...(tool.riskTier ? { riskTier: tool.riskTier } : {}),
      trace,
    };
    const step = (rule: string, detail: string, decided = false): void => {
      trace.push({ rule, detail, decided });
    };
    const stop = (outcome: PermissionOutcome, reason?: string): PermissionEvaluation => {
      const last = trace[trace.length - 1];
      if (last) last.decided = true;
      return { ...base, outcome, ...(reason ? { reason } : {}) };
    };

    // A hard tool-level deny wins in every mode — including yolo (fail-closed).
    if (level === "deny") {
      step("tool-level", `${tool.name} is set to "deny"; this wins in every mode`);
      return stop("deny");
    }
    step(
      "tool-level",
      `level "${level}"${base.overridden ? " (from an override)" : ""} — not a hard deny, so the ladder continues`,
    );

    // Brain Arbiter runs in every mode so a "critical" call (e.g. rm -rf /) is blocked
    // even under yolo. "escalate" forces a human prompt; "allow" approves outright.
    let arbiterDecision: ArbiterDecision = "default";
    if (this.arbiter) {
      const verdict = this.arbiter.decide(tool, args, {
        mode: this.mode,
        category,
        unattended: this.unattended,
      });
      const said =
        verdict.decision === "default"
          ? "no opinion — defers to the mode"
          : `${verdict.decision}${verdict.reason ? ` — ${verdict.reason}` : ""}`;
      step("arbiter", said);
      if (verdict.decision === "deny") return stop("deny", verdict.reason);
      arbiterDecision = verdict.decision;
    } else {
      step("arbiter", "not configured — nothing screens command arguments");
    }

    // A tool tagged destructive re-prompts even in non-ask modes when the gate is on.
    const destructiveGate = this.confirmDestructive && tool.riskTier === "destructive";
    const forceAsk = arbiterDecision === "escalate" || destructiveGate;
    if (destructiveGate) {
      step("confirm-destructive", "tool is destructive and the gate is on — a prompt is forced");
    }

    // yolo: approve everything that survived the deny/critical checks without prompting,
    // unless the destructive-confirm gate explicitly demands a prompt.
    if (this.mode === "yolo") {
      if (destructiveGate) return stop("prompt");
      step("mode:yolo", "approves anything that survived the deny and arbiter checks");
      return stop("allow");
    }

    // Plan mode is read-only: anything that mutates is blocked outright.
    if (this.mode === "plan" && category !== "read") {
      const reason = "plan mode is read-only — switch to ask/auto (Shift+Tab) to make changes";
      step("mode:plan", `category "${category}" mutates state`);
      return stop("deny", reason);
    }

    if (!forceAsk && (level === "allow" || arbiterDecision === "allow")) {
      step(
        level === "allow" ? "tool-level" : "arbiter",
        level === "allow"
          ? 'this tool is "allow", so it never prompts'
          : "approved this call outright",
      );
      return stop("allow");
    }

    // Auto mode silently approves file edits. It ALSO runs shell/execute commands
    // without a prompt — but only while an arbiter is screening them: safe commands
    // pass, risky ones (rm -rf, sudo, force-push, and the Windows equivalents like
    // `del /s`, `Remove-Item -Recurse`, `runas`…) were escalated above, and critical
    // ones (rm -rf /, format, whole-drive wipes) were already denied. With no arbiter
    // there's nothing screening the command, so execute tools still prompt (fail-safe).
    if (!forceAsk && this.mode === "auto") {
      if (category === "edit") {
        step("mode:auto", "file edits are approved without a prompt");
        return stop("allow");
      }
      if (category === "execute" && this.arbiter) {
        step("mode:auto", "the arbiter screened this command, so it runs without a prompt");
        return stop("allow");
      }
      if (category === "execute") {
        step("mode:auto", "no arbiter is screening commands, so execute tools still prompt");
      }
    }

    step("prompt", forceAsk ? "a prompt was forced above" : "no rule pre-decided this call");
    return stop("prompt");
  }

  async check(
    tool: Tool,
    args: Record<string, unknown>,
    ask: PermissionAsker,
  ): Promise<PermissionDecision> {
    const evaluation = this.evaluate(tool, args);
    if (evaluation.outcome === "allow") return { allowed: true, persist: false };
    if (evaluation.outcome === "deny") {
      return {
        allowed: false,
        persist: false,
        ...(evaluation.reason ? { reason: evaluation.reason } : {}),
      };
    }
    return this.prompt(tool, args, ask);
  }

  private async prompt(
    tool: Tool,
    args: Record<string, unknown>,
    ask: PermissionAsker,
  ): Promise<PermissionDecision> {
    const answer = await ask(tool, args);
    if (answer === "allow_always") {
      this.overrides[tool.name] = "allow";
      return { allowed: true, persist: true };
    }
    return { allowed: answer === "allow", persist: false };
  }

  /** Snapshot of overrides for persistence. */
  snapshot(): Record<string, PermissionLevel> {
    return { ...this.overrides };
  }
}
