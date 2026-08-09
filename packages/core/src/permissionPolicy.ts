import { RiskArbiter } from "./arbiter.js";
import type { ArtermConfig } from "./config.js";
import { PermissionManager, type PermissionMode } from "./permissions.js";
import type { PermissionAsker } from "./types.js";

export interface PermissionPolicyOptions {
  /** Force yolo (the `--yolo` flag) regardless of the configured mode. */
  yolo?: boolean;
  /** Explicit mode, overriding both `yolo` and the config. */
  mode?: PermissionMode;
  /** Re-prompt for destructive tools even in auto/yolo (overrides config). */
  confirmDestructive?: boolean;
  /**
   * Nobody is at the keyboard (`--autonomous`, headless `--print`).
   *
   * Not derivable from the mode: attended yolo is a user who typed `--yolo` and
   * is watching, and the two want opposite answers to an escalation. `arterm
   * permissions explain` passes it too, or the explainer would describe the
   * attended policy for a run that is not.
   */
  unattended?: boolean;
}

/**
 * Build the permission policy a session would run under.
 *
 * The single place that turns config into a `PermissionManager`. A session and
 * `arterm permissions explain` must resolve the *same* policy from the *same*
 * config, or the explainer describes a session nobody is running — so both call
 * this rather than assembling the pieces themselves.
 */
export function createPermissionManager(
  config: ArtermConfig,
  opts: PermissionPolicyOptions = {},
): PermissionManager {
  const mode: PermissionMode = opts.mode ?? (opts.yolo ? "yolo" : (config.mode ?? "ask"));
  const arbiter = config.arbiter?.enabled === false ? undefined : new RiskArbiter();
  const confirmDestructive = opts.confirmDestructive ?? config.confirmDestructive ?? false;
  return new PermissionManager(
    config.permissions,
    mode,
    arbiter,
    confirmDestructive,
    opts.unattended ?? false,
  );
}

/**
 * The permission policy a sub-agent should run under, or `undefined` to keep
 * the session's shared manager and prompting asker (today's behavior).
 *
 * A sub-agent cannot answer an interactive prompt — it runs under the main
 * agent, not the user. In an autonomous session (mode `auto`/`yolo`, or
 * `fleet.autoApprove` opted in), blocking a fleet on a TUI prompt the user may
 * never see defeats the point: the user authorized the work when they chose the
 * autonomous mode. So sub-agents get their own manager where escalations FAIL
 * CLOSED — the asker answers "deny" with a reason instead of hanging — and the
 * ladder above yolo is untouched: explicit per-tool `deny` overrides in
 * `config.permissions` and the arbiter's critical block still win, because
 * `evaluate()` consults them before the mode. No new capability machinery:
 * per-tool overrides + team `toolNames` allowlists + the arbiter are the
 * existing blast-radius controls, and this reuses all three.
 *
 * In `ask`/`plan` sessions without `fleet.autoApprove`, returns `undefined`:
 * a supervised session keeps routing sub-agent prompts to the human.
 *
 * Call this at DISPATCH time, not session build time — the live mode is
 * mutable (Shift+Tab), and the policy must reflect the mode the user is
 * actually in when the sub-agent spawns.
 */
export function subagentPolicy(
  config: ArtermConfig,
  sessionPermissions: PermissionManager,
): { permissions: PermissionManager; ask: PermissionAsker } | undefined {
  const live = sessionPermissions.getMode();
  const autoApprove = config.fleet?.autoApprove === true;
  if (!autoApprove && (live === "ask" || live === "plan")) return undefined;
  const mode: PermissionMode = autoApprove ? "yolo" : live;
  const arbiter = config.arbiter?.enabled === false ? undefined : new RiskArbiter();
  return {
    permissions: new PermissionManager(
      config.permissions,
      mode,
      arbiter,
      config.confirmDestructive ?? false,
    ),
    // The only prompts that survive a yolo/auto evaluation are arbiter
    // escalations and the destructive-confirm gate; silently approving those
    // would widen the ladder. Deny with a reason, never hang.
    ask: async () => "deny",
  };
}

/**
 * The optional model-based gatekeeper (`arbiter.model`) is NOT part of the
 * policy above — it is a pipeline stage that runs *before* it and can only
 * block. An explainer must say so instead of implying the ladder is the whole
 * story; evaluating it would cost a provider call.
 */
export function brainArbiterModel(config: ArtermConfig): string | undefined {
  if (config.arbiter?.enabled === false) return undefined;
  return config.arbiter?.model;
}
