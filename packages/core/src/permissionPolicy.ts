import { RiskArbiter } from "./arbiter.js";
import type { ArtermConfig } from "./config.js";
import { PermissionManager, type PermissionMode } from "./permissions.js";

export interface PermissionPolicyOptions {
  /** Force yolo (the `--yolo` flag) regardless of the configured mode. */
  yolo?: boolean;
  /** Explicit mode, overriding both `yolo` and the config. */
  mode?: PermissionMode;
  /** Re-prompt for destructive tools even in auto/yolo (overrides config). */
  confirmDestructive?: boolean;
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
  return new PermissionManager(config.permissions, mode, arbiter, confirmDestructive);
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
