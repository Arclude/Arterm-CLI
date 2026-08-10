import type { ArtermConfig, AutonomyMode, PermissionMode } from "@arterm/core";

/** The subset of the CLI's global flags the autonomous profile consumes. */
export interface AutonomousFlagOpts {
  /** Unattended profile: yolo + verify-persist + sub-agent auto-approve + auto-extend. */
  autonomous?: boolean;
  /** Autonomy mode for this run (once | eternal | parallel | phased | team). */
  autonomyMode?: string;
  /** Step-cap override; with eternal mode, a hard bound (CI/testing hook). */
  maxSteps?: string;
  /** Whole-run token ceiling (`--max-tokens`). */
  maxTokens?: string;
  /** Whole-run USD ceiling (`--max-usd`). */
  maxUsd?: string;
  /** Whole-run wall-clock ceiling in seconds (`--max-duration`). */
  maxDuration?: string;
  /** Roster size for this run (`--tools-tier`), overriding `tools.tier`. */
  toolsTier?: string;
  /**
   * `--sandbox` / `--no-sandbox`. Undefined means "unstated", which is what lets
   * `--autonomous` supply the boundary without overriding a deliberate choice.
   */
  sandbox?: boolean;
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
 * Every switch named above REMOVES a control. `applySandboxFlag` (below) is the
 * one that adds one back, and it is the reason this profile is defensible at
 * all: without a boundary, "unattended" is a shell holding the operator's full
 * identity, driven by a model, for hours, with nobody reading the output.
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
  applyBudgetFlags(config, globals, warn);
  applyToolsTierFlag(config, globals, warn);
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
  applySandboxFlag(config, globals, warn);
  return { hardCap };
}

/**
 * Decide whether this run gets an execution boundary, and say so either way.
 *
 * `--autonomous` is the reason this exists. Every other switch it flips REMOVES
 * a control: prompts off, sub-agent approval off, the rejection cap off. The
 * sandbox is the only one that adds something back, and without it "unattended"
 * means a shell with the operator's full identity, driven by a model, for hours,
 * with nobody reading the output. The permission ladder cannot help here — it
 * decides whether a command runs, and yolo has already answered yes.
 *
 * The sandbox is now ON for both (`defaultConfig()`), and what stays asymmetric
 * is what happens when it cannot be ESTABLISHED:
 *   - unattended  → fail CLOSED. The run does nothing rather than doing some of
 *                   it unconfined, because nobody is there to read a warning.
 *   - attended    → warn and continue. A boundary that stops a developer's
 *                   session from starting gets switched off permanently the
 *                   first time it does, and off is worth less than degraded.
 *
 * That the boundary EXISTS is no longer conditional on the mode; only the
 * response to its absence is. The prompt is still the control an attended
 * session has, but it answers a different question — "yes, run `pnpm test`" is
 * not consent for `pnpm test` to write outside the project or dial an arbitrary
 * host.
 *
 * `--no-sandbox` is a real escape hatch, not a formality: some hosts have no
 * user namespaces, some workflows need egress this cannot express, and making
 * `--autonomous` unusable without a working sandbox just pushes people back to
 * bare `--yolo`, which announces nothing at all. It is loud instead of absent —
 * the same reasoning as the ungated-run warning above.
 */
function applySandboxFlag(
  config: ArtermConfig,
  globals: AutonomousFlagOpts,
  warn: (msg: string) => void,
): void {
  if (globals.sandbox === false) {
    config.sandbox = { ...config.sandbox, enabled: false };
    if (globals.autonomous) {
      warn(
        "⚠ --no-sandbox: shell commands run on the host with your identity and unrestricted " +
          "network. With prompts off, nothing constrains what an allowed command can reach.\n",
      );
    }
    return;
  }
  const on = globals.sandbox === true || globals.autonomous === true || config.sandbox?.enabled;
  if (!on) return;
  config.sandbox = {
    ...config.sandbox,
    enabled: true,
    // Unattended fails closed. A warning is a control only if someone reads it,
    // and the defining property of this mode is that nobody is there.
    failIfUnavailable: config.sandbox?.failIfUnavailable ?? globals.autonomous === true,
  };
  if (globals.autonomous) {
    const domains = config.sandbox.allowedDomains?.length ?? 0;
    warn(
      `◆ sandbox ON: shell commands are confined to this directory and reach ${
        domains === 0 ? "no network" : `${domains} allowed domain${domains === 1 ? "" : "s"}`
      }. The run stops if the boundary cannot be established (--no-sandbox to opt out).\n`,
    );
  }
}

/**
 * Overlay `--max-tokens` / `--max-usd` onto the config's run ceilings.
 *
 * Unlike the per-turn caps these bound the WHOLE run, which is what makes an
 * unattended one bounded in money rather than only in steps — `autoExtend`
 * keeps buying steps for as long as anything happens, so without this the only
 * thing that ends a productive-looking loop is the loop detector.
 *
 * An unparseable value warns and is ignored rather than silently becoming
 * "unlimited": a typo'd ceiling that reads as no ceiling is the worst outcome
 * of the three.
 */
function applyBudgetFlags(
  config: ArtermConfig,
  globals: AutonomousFlagOpts,
  warn: (msg: string) => void,
): void {
  if (globals.maxTokens !== undefined) {
    const n = Number(globals.maxTokens);
    if (!Number.isInteger(n) || n < 1) {
      warn(`⚠ invalid --max-tokens "${globals.maxTokens}" — ignoring\n`);
    } else {
      config.budget = { ...config.budget, runTokens: n };
    }
  }
  if (globals.maxUsd !== undefined) {
    const n = Number(globals.maxUsd);
    if (!Number.isFinite(n) || n <= 0) {
      warn(`⚠ invalid --max-usd "${globals.maxUsd}" — ignoring\n`);
    } else {
      config.budget = { ...config.budget, runUsd: n };
    }
  }
  if (globals.maxDuration !== undefined) {
    const n = Number(globals.maxDuration);
    if (!Number.isFinite(n) || n <= 0) {
      warn(`⚠ invalid --max-duration "${globals.maxDuration}" — ignoring\n`);
    } else {
      config.budget = { ...config.budget, runSeconds: n };
    }
  }
}

const TOOL_TIERS = new Set(["minimal", "standard", "full"]);

/**
 * Pick the roster size for THIS run, overriding `tools.tier`.
 *
 * The tiers already existed; what was missing is a way to choose one without
 * writing `~/.arterm/config.json`, and a benchmark container has no config to
 * write — every sweep therefore measured `standard` whether or not that was the
 * roster anyone meant to score. The same gap makes an A/B impossible: two runs
 * that differ only in roster size cannot be expressed at all.
 *
 * It matters more than a tuning knob suggests. Every tool's schema is re-sent
 * on every request, so the roster is a fixed per-turn tax — measured here at
 * 10,662 tokens of fixed prefix across 59 tools. And the cost is not only
 * tokens: the published work has each sibling tool acting as a distractor, with
 * Terminal-Bench's own reference harness exposing exactly ONE tool, so a
 * smaller roster is plausibly the more accurate one as well as the cheaper one.
 * Neither claim is worth believing without measuring it on our own runs, which
 * is what this flag exists to allow.
 *
 * An unknown tier warns and keeps the configured roster rather than falling
 * back to a default: silently scoring a different roster than the one named is
 * the failure this whole flag exists to end.
 */
function applyToolsTierFlag(
  config: ArtermConfig,
  globals: AutonomousFlagOpts,
  warn: (msg: string) => void,
): void {
  if (globals.toolsTier === undefined) return;
  if (!TOOL_TIERS.has(globals.toolsTier)) {
    warn(
      `⚠ unknown --tools-tier "${globals.toolsTier}" (expected ${[...TOOL_TIERS].join(" | ")}) — ` +
        `keeping "${config.tools?.tier ?? "standard"}"\n`,
    );
    return;
  }
  config.tools = { ...config.tools, tier: globals.toolsTier as "minimal" | "standard" | "full" };
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
export function warnUngatedRun(config: ArtermConfig, warn: (msg: string) => void): void {
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

/**
 * The prompt `--print` carried, if it carried one.
 *
 * `--print [prompt]` takes an OPTIONAL value, so commander reports the bare flag
 * as `true` rather than a string — and `true` is not a prompt, it is the request
 * to go headless with the prompt arriving on stdin. Reading it as one is what
 * made `arterm --print --json` die on `prompt.trim is not a function` before it
 * ever looked at stdin: the documented way to pipe a prompt and get JSON back
 * was the one invocation that could not work.
 *
 * Returning `undefined` for the bare flag is the whole behaviour — the caller
 * then falls through to stdin, and an empty stdin still produces the real error
 * ("no prompt provided"), which is the message that actually helps.
 */
export function printedPrompt(print: string | true | undefined): string | undefined {
  return typeof print === "string" ? print : undefined;
}

/** The live objects `armAutonomous` flips — deliberately narrow so tests can fake them. */
export interface RuntimeAutonomousHooks {
  config: ArtermConfig;
  /** The session's mutable permission manager. */
  permissions: { getMode(): PermissionMode; setMode(mode: PermissionMode): void };
  /** The session's autonomy engine (its runtime unattended-switch setter). */
  engine: { setUnattended(patch: { verifyPersist?: boolean; autoExtend?: boolean }): void };
}

/**
 * Arm autonomous mode on a LIVE session — the Shift+Tab counterpart of the
 * boot-time `--autonomous` profile.
 *
 * Deliberately touches no config. Yolo goes through the mutable
 * PermissionManager, which `subagentPolicy()` re-reads at every dispatch — so
 * sub-agent auto-approve follows from the mode with no `fleet.autoApprove`
 * write. Verify-persist and auto-extend go through the engine's runtime
 * setter. The config object is persisted on exit, so writing the profile into
 * it would make "quit while armed" mean "every later session boots in yolo".
 *
 * The loop detector cannot be armed here — it is wired at Agent construction —
 * so a config that explicitly disabled it gets a warning instead of a silent
 * gap (the default is on, making this the rare case).
 *
 * `disarm` lands on ASK, not the prior mode. The prior mode is almost always
 * "plan" (the cycle position before this one), and when it isn't, it was an
 * explicit /yolo — restoring that would make "leave autonomous" quietly keep
 * prompts off. The safe floor is the only unsurprising target.
 */
export function armAutonomous(hooks: RuntimeAutonomousHooks): {
  messages: string[];
  disarm: () => string[];
} {
  const { config, permissions, engine } = hooks;
  permissions.setMode("yolo");
  engine.setUnattended({ verifyPersist: true, autoExtend: true });
  const messages: string[] = [
    "◆ AUTONOMOUS armed: permission prompts are OFF (yolo — explicit deny rules and the " +
      "arbiter's critical block still apply); verify-persist, sub-agent auto-approve, and " +
      "step auto-extend are ON. A plain prompt now launches an autonomous goal; Shift+Tab " +
      "disarms.",
  ];
  if (config.loopDetect.enabled === false) {
    messages.push(
      "⚠ loopDetect.enabled: false — the detector is wired at startup and cannot be armed " +
        "mid-session, so this run has NO loop guard. Restart with --autonomous to force it on.",
    );
  }
  warnUngatedRun(config, (m) => messages.push(m.trimEnd()));
  const disarm = (): string[] => {
    permissions.setMode("ask");
    // Back to what the config actually says — which arming never changed.
    engine.setUnattended({
      verifyPersist: config.verify.persist ?? false,
      autoExtend: config.autonomy.autoExtend ?? false,
    });
    return ["◆ autonomous disarmed — permission mode → ASK; a plain prompt is a plain turn again."];
  };
  return { messages, disarm };
}
