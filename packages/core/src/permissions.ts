import type { ToolArbiter } from "./arbiter.js";
import type { PermissionAsker, PermissionLevel, Tool, ToolCategory } from "./types.js";

/**
 * Session permission mode (cycle with Shift+Tab in the TUI):
 *   - "ask":  prompt before edit/execute tools (the default).
 *   - "auto": auto-approve file edits; still prompt for shell/execute tools.
 *   - "plan": read-only — block every edit/execute tool, no prompts.
 *   - "yolo": approve everything, no prompts.
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

  constructor(
    overrides: Record<string, PermissionLevel> = {},
    mode: PermissionMode = "ask",
    arbiter?: ToolArbiter,
  ) {
    this.overrides = { ...overrides };
    this.mode = mode;
    this.arbiter = arbiter;
  }

  getMode(): PermissionMode {
    return this.mode;
  }

  setMode(mode: PermissionMode): void {
    this.mode = mode;
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
    if (this.mode === "yolo") return { allowed: true, persist: false };

    const category = this.category(tool);

    // Plan mode is read-only: anything that mutates is blocked outright.
    if (this.mode === "plan" && category !== "read") {
      return {
        allowed: false,
        persist: false,
        reason: "plan mode is read-only — switch to ask/auto (Shift+Tab) to make changes",
      };
    }

    const level = this.level(tool);
    if (level === "allow") return { allowed: true, persist: false };
    if (level === "deny") return { allowed: false, persist: false };

    // Brain Arbiter: classify the call's risk and possibly deny / force-escalate.
    let forceAsk = false;
    if (this.arbiter) {
      const verdict = this.arbiter.decide(tool, args, { mode: this.mode, category });
      if (verdict.decision === "deny") {
        return { allowed: false, persist: false, reason: verdict.reason };
      }
      if (verdict.decision === "allow") return { allowed: true, persist: false };
      if (verdict.decision === "escalate") forceAsk = true;
    }

    // Auto mode silently approves file edits, but still prompts for execute tools
    // (and anything the arbiter escalated).
    if (!forceAsk && this.mode === "auto" && category === "edit") {
      return { allowed: true, persist: false };
    }

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
