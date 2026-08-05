import type { ArtermConfig, AutonomyMode } from "@arterm/core";

/** The subset of the CLI's global flags the autonomous profile consumes. */
export interface AutonomousFlagOpts {
  /** Unattended profile: yolo + verify-persist + sub-agent auto-approve + auto-extend. */
  autonomous?: boolean;
  /** Autonomy mode for this run (once | eternal | parallel | phased | team). */
  autonomyMode?: string;
  /** Step-cap override; with eternal mode, a hard bound (CI/testing hook). */
  maxSteps?: string;
  /** Mutated to true by `--autonomous` (feeds the session's permission mode). */
  yolo?: boolean;
}

const AUTONOMY_MODES = new Set(["once", "eternal", "parallel", "phased", "team"]);

/**
 * Overlay the unattended-run flags onto the loaded config.
 *
 * `--autonomous` is one switch that flips the five things an unattended run
 * needs (yolo, verify-persist, sub-agent auto-approve, progress-gated step
 * extension, and the loop detector), because forgetting any one of them turns
 * "walk away" into "come back to a prompt that has been waiting since minute
 * two". It announces itself on stderr — silently disabling permission prompts
 * is not acceptable.
 *
 * The loop detector is FORCED on, overriding an explicit `loopDetect.enabled:
 * false` — the one profile entry that wins over config rather than defaulting
 * under it. The reason is arithmetic, not taste: verify-persist keeps the run
 * going after rejections, auto-extend counts each verification attempt as
 * progress, so with the detector off a run failing the same gate forever earns
 * an extension forever — observed running unbounded until an external timeout
 * killed it. The detector is the only guard that breaks that cycle, and the
 * announcement already promises it is on; honoring `false` here would make
 * that line a lie. Overriding an explicit config choice is not done silently:
 * it gets its own warning. Anyone who truly wants an undetected unattended
 * run can still say bare `--yolo` — which promises nothing.
 *
 * It also names the gap it cannot close. An unattended run with no standing
 * command gate accepts completion on the judge's reading alone, and a judge
 * that only reads the final tree cannot see what changed — so it cannot catch
 * work that contradicts the goal. That is not hypothetical: a fleet worker
 * rewrote the function it was told not to touch, committed it as `docs(...)`,
 * and the judge passed it with "the function's behavior was not touched". The
 * exit code is the only part of the gate that could have known.
 *
 * Returns whether `--max-steps` was accepted: that (and only that) makes the
 * step cap bound an eternal run too, so a CI harness can say "eternal
 * semantics, but never more than N steps" while config alone can never
 * accidentally bound eternal.
 */
export function applyAutonomousProfile(
  config: ArtermConfig,
  globals: AutonomousFlagOpts,
  warn: (msg: string) => void = (msg) => process.stderr.write(msg),
): { hardCap: boolean } {
  if (globals.autonomyMode !== undefined) {
    if (!AUTONOMY_MODES.has(globals.autonomyMode)) {
      warn(
        `⚠ unknown --autonomy-mode "${globals.autonomyMode}" (expected ${[...AUTONOMY_MODES].join(" | ")}) — keeping "${config.autonomy.mode}"\n`,
      );
    } else {
      config.autonomy = { ...config.autonomy, mode: globals.autonomyMode as AutonomyMode };
    }
  }
  let hardCap = false;
  if (globals.maxSteps !== undefined) {
    const n = Number(globals.maxSteps);
    if (!Number.isInteger(n) || n < 1) {
      warn(`⚠ invalid --max-steps "${globals.maxSteps}" — ignoring\n`);
    } else {
      config.autonomy = { ...config.autonomy, maxSteps: n };
      hardCap = true;
    }
  }
  if (globals.autonomous) {
    globals.yolo = true;
    config.verify = { ...config.verify, persist: true };
    config.autonomy = { ...config.autonomy, autoExtend: true };
    config.fleet = { ...config.fleet, autoApprove: true };
    if (config.loopDetect.enabled === false) {
      warn(
        "⚠ loopDetect.enabled: false is overridden for this run — with verify-persist and " +
          "auto-extend on, the loop detector is the only guard that stops a run repeating " +
          "the same failing step forever.\n",
      );
    }
    config.loopDetect = { ...config.loopDetect, enabled: true };
    warn(
      "◆ autonomous mode: permission prompts are OFF (yolo — explicit deny rules and the " +
        "arbiter's critical block still apply); verify-persist, sub-agent auto-approve, " +
        "loop detector, and step auto-extend are ON.\n",
    );
    warnUngatedRun(config, warn);
  }
  return { hardCap };
}

/**
 * Name what an unattended run is — and is not — checking before it walks away.
 *
 * Deliberately a warning and not a refusal. A standing gate is the right default
 * but not always available: plenty of goals have no command that can judge them,
 * and turning `--autonomous` into "unusable without --verify-cmd" would push
 * people back to bare `--yolo`, which announces nothing at all. The failure mode
 * this addresses is not knowing the gate was absent, so saying so is the fix.
 */
function warnUngatedRun(config: ArtermConfig, warn: (msg: string) => void): void {
  if (config.verify.enabled === false) {
    warn(
      "⚠ verification is OFF (verify.enabled: false) — nothing checks this run's completion " +
        "claims. Whatever it says it did is what you get.\n",
    );
    return;
  }
  if (!config.verify.command?.trim()) {
    warn(
      "⚠ no standing verification gate: completion rests on the judge alone, which only READS " +
        "the result — it cannot see what changed, so it cannot catch work that contradicts the " +
        "goal. Pass --verify-cmd '<command>' (or set verify.command) to gate on an exit code.\n",
    );
  }
}
