import type { PermissionAsker, PermissionLevel, Tool } from "./types.js";

export interface PermissionDecision {
  allowed: boolean;
  /** True when the user chose "always" — caller should persist it. */
  persist: boolean;
}

/**
 * Resolves whether a tool call may run, consulting (in order):
 *   1. a session-wide bypass (yolo)
 *   2. per-tool overrides (from config / "always allow")
 *   3. the tool's own default permission
 * When the effective level is "ask", the supplied asker is invoked.
 */
export class PermissionManager {
  private overrides: Record<string, PermissionLevel>;

  constructor(
    overrides: Record<string, PermissionLevel> = {},
    private readonly yolo = false,
  ) {
    this.overrides = { ...overrides };
  }

  /** Current effective level for a tool, ignoring yolo. */
  level(tool: Tool): PermissionLevel {
    return this.overrides[tool.name] ?? tool.permission;
  }

  async check(
    tool: Tool,
    args: Record<string, unknown>,
    ask: PermissionAsker,
  ): Promise<PermissionDecision> {
    if (this.yolo) return { allowed: true, persist: false };

    const level = this.level(tool);
    if (level === "allow") return { allowed: true, persist: false };
    if (level === "deny") return { allowed: false, persist: false };

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
