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

  constructor(
    overrides: Record<string, PermissionLevel> = {},
    mode: PermissionMode = "ask",
    arbiter?: ToolArbiter,
    confirmDestructive = false,
  ) {
    this.overrides = { ...overrides };
    this.mode = mode;
    this.arbiter = arbiter;
    this.confirmDestructive = confirmDestructive;
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

  async check(
    tool: Tool,
    args: Record<string, unknown>,
    ask: PermissionAsker,
  ): Promise<PermissionDecision> {
    const category = this.category(tool);
    const level = this.level(tool);

    // A hard tool-level deny wins in every mode — including yolo (fail-closed).
    if (level === "deny") return { allowed: false, persist: false };

    // Brain Arbiter runs in every mode so a "critical" call (e.g. rm -rf /) is blocked
    // even under yolo. "escalate" forces a human prompt; "allow" approves outright.
    let arbiterDecision: ArbiterDecision = "default";
    if (this.arbiter) {
      const verdict = this.arbiter.decide(tool, args, { mode: this.mode, category });
      if (verdict.decision === "deny") {
        return { allowed: false, persist: false, reason: verdict.reason };
      }
      arbiterDecision = verdict.decision;
    }

    // A tool tagged destructive re-prompts even in non-ask modes when the gate is on.
    const destructiveGate = this.confirmDestructive && tool.riskTier === "destructive";
    const forceAsk = arbiterDecision === "escalate" || destructiveGate;

    // yolo: approve everything that survived the deny/critical checks without prompting,
    // unless the destructive-confirm gate explicitly demands a prompt.
    if (this.mode === "yolo") {
      if (destructiveGate) return this.prompt(tool, args, ask);
      return { allowed: true, persist: false };
    }

    // Plan mode is read-only: anything that mutates is blocked outright.
    if (this.mode === "plan" && category !== "read") {
      return {
        allowed: false,
        persist: false,
        reason: "plan mode is read-only — switch to ask/auto (Shift+Tab) to make changes",
      };
    }

    if (!forceAsk && (level === "allow" || arbiterDecision === "allow")) {
      return { allowed: true, persist: false };
    }

    // Auto mode silently approves file edits. It ALSO runs shell/execute commands
    // without a prompt — but only while an arbiter is screening them: safe commands
    // pass, risky ones (rm -rf, sudo, force-push, and the Windows equivalents like
    // `del /s`, `Remove-Item -Recurse`, `runas`…) were escalated above, and critical
    // ones (rm -rf /, format, whole-drive wipes) were already denied. With no arbiter
    // there's nothing screening the command, so execute tools still prompt (fail-safe).
    if (!forceAsk && this.mode === "auto") {
      if (category === "edit") return { allowed: true, persist: false };
      if (category === "execute" && this.arbiter) return { allowed: true, persist: false };
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
