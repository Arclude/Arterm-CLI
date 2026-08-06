import { defaultConfig } from "@arterm/core";
import { describe, expect, it } from "vitest";
import { applyAutonomousProfile, armAutonomous } from "./flags.js";

describe("applyAutonomousProfile (--autonomous / --autonomy-mode / --max-steps)", () => {
  it("--autonomous flips all five unattended switches and announces itself", () => {
    const config = defaultConfig();
    const globals = { autonomous: true, yolo: undefined as boolean | undefined };
    const warnings: string[] = [];
    applyAutonomousProfile(config, globals, (m) => warnings.push(m));
    expect(globals.yolo).toBe(true);
    expect(config.verify.persist).toBe(true);
    expect(config.autonomy.autoExtend).toBe(true);
    expect(config.fleet.autoApprove).toBe(true);
    expect(config.loopDetect.enabled).toBe(true);
    expect(warnings.join("")).toContain("autonomous mode");
  });

  it("--autonomous supplies the one control it does not remove: the sandbox", () => {
    const config = defaultConfig();
    expect(config.sandbox.enabled).toBe(false); // attended default
    const warnings: string[] = [];
    applyAutonomousProfile(config, { autonomous: true }, (m) => warnings.push(m));
    expect(config.sandbox.enabled).toBe(true);
    // Unattended has to REFUSE rather than warn — nobody is reading stderr.
    expect(config.sandbox.failIfUnavailable).toBe(true);
    expect(warnings.join("")).toContain("sandbox ON");
  });

  it("--no-sandbox opts out loudly rather than silently", () => {
    const config = defaultConfig();
    const warnings: string[] = [];
    applyAutonomousProfile(config, { autonomous: true, sandbox: false }, (m) => warnings.push(m));
    expect(config.sandbox.enabled).toBe(false);
    // The escape hatch exists so people don't fall back to bare --yolo, which
    // announces nothing at all — so this one has to announce.
    expect(warnings.join("")).toContain("--no-sandbox");
    expect(warnings.join("")).toContain("unrestricted network");
  });

  it("--sandbox arms the boundary for a plain run, but fails OPEN there", () => {
    const config = defaultConfig();
    const warnings: string[] = [];
    applyAutonomousProfile(config, { sandbox: true }, (m) => warnings.push(m));
    expect(config.sandbox.enabled).toBe(true);
    // Someone is at the keyboard: a broken boundary is reportable, not fatal.
    expect(config.sandbox.failIfUnavailable).toBe(false);
    expect(warnings.join("")).toBe("");
  });

  it("leaves the sandbox alone for a plain run with no flag", () => {
    const config = defaultConfig();
    applyAutonomousProfile(config, {}, () => {});
    expect(config.sandbox.enabled).toBe(false);
  });

  it("keeps an explicit config failIfUnavailable over the unattended inference", () => {
    const config = defaultConfig();
    config.sandbox = { ...config.sandbox, failIfUnavailable: false };
    applyAutonomousProfile(config, { autonomous: true }, () => {});
    expect(config.sandbox.enabled).toBe(true);
    expect(config.sandbox.failIfUnavailable).toBe(false);
  });

  it("--autonomous forces the loop detector back on and says so", () => {
    const config = defaultConfig();
    // Explicitly disabled in config: persist + auto-extend with no detector is
    // the unbounded combination — each verification attempt counts as progress,
    // so a run failing the same gate forever earns an extension forever.
    config.loopDetect = { ...config.loopDetect, enabled: false };
    const warnings: string[] = [];
    applyAutonomousProfile(config, { autonomous: true }, (m) => warnings.push(m));
    expect(config.loopDetect.enabled).toBe(true);
    expect(warnings.join("")).toContain("loopDetect.enabled: false is overridden");
  });

  it("does not claim an override when the detector was already on", () => {
    const config = defaultConfig();
    const warnings: string[] = [];
    applyAutonomousProfile(config, { autonomous: true }, (m) => warnings.push(m));
    expect(warnings.join("")).not.toContain("overridden");
  });

  it("leaves a disabled detector alone without --autonomous", () => {
    const config = defaultConfig();
    config.loopDetect = { ...config.loopDetect, enabled: false, steerAfter: 7 };
    applyAutonomousProfile(config, { autonomyMode: "eternal" }, () => {});
    expect(config.loopDetect.enabled).toBe(false);
    // Forcing the switch never touches the thresholds either way.
    expect(config.loopDetect.steerAfter).toBe(7);
  });

  it("--autonomous names the missing standing gate, because the judge only reads", () => {
    const config = defaultConfig();
    const warnings: string[] = [];
    applyAutonomousProfile(config, { autonomous: true }, (m) => warnings.push(m));
    expect(warnings.join("")).toContain("no standing verification gate");
    expect(warnings.join("")).toContain("--verify-cmd");
  });

  it("stays quiet about the gate once a command is configured", () => {
    const config = defaultConfig();
    config.verify = { ...config.verify, command: "pnpm -r test" };
    const warnings: string[] = [];
    applyAutonomousProfile(config, { autonomous: true }, (m) => warnings.push(m));
    expect(warnings.join("")).not.toContain("no standing verification gate");
  });

  it("treats a blank command as no gate at all", () => {
    const config = defaultConfig();
    config.verify = { ...config.verify, command: "   " };
    const warnings: string[] = [];
    applyAutonomousProfile(config, { autonomous: true }, (m) => warnings.push(m));
    expect(warnings.join("")).toContain("no standing verification gate");
  });

  it("says so plainly when verification is off entirely", () => {
    const config = defaultConfig();
    config.verify = { ...config.verify, enabled: false, command: "pnpm -r test" };
    const warnings: string[] = [];
    applyAutonomousProfile(config, { autonomous: true }, (m) => warnings.push(m));
    // A configured command is irrelevant when the layer that runs it is off —
    // reporting the gate as present here would be the more dangerous message.
    expect(warnings.join("")).toContain("verification is OFF");
    expect(warnings.join("")).not.toContain("no standing verification gate");
  });

  it("warns about the gate only for --autonomous, not for a plain run", () => {
    const config = defaultConfig();
    const warnings: string[] = [];
    applyAutonomousProfile(config, { autonomyMode: "eternal" }, (m) => warnings.push(m));
    expect(warnings.join("")).toBe("");
  });

  it("leaves the config untouched without any of the flags", () => {
    const config = defaultConfig();
    const { hardCap } = applyAutonomousProfile(config, {}, () => {});
    expect(hardCap).toBe(false);
    expect(config.verify.persist).toBeUndefined();
    expect(config.autonomy.autoExtend).toBe(false);
    expect(config.fleet.autoApprove).toBe(false);
  });

  it("--autonomy-mode switches the mode; unknown values warn and keep the config", () => {
    const config = defaultConfig();
    applyAutonomousProfile(config, { autonomyMode: "eternal" }, () => {});
    expect(config.autonomy.mode).toBe("eternal");
    const warnings: string[] = [];
    applyAutonomousProfile(config, { autonomyMode: "forever" }, (m) => warnings.push(m));
    expect(config.autonomy.mode).toBe("eternal");
    expect(warnings.join("")).toContain("unknown --autonomy-mode");
  });

  it("--max-steps overrides the cap and is the ONLY thing that bounds eternal", () => {
    const config = defaultConfig();
    const { hardCap } = applyAutonomousProfile(config, { maxSteps: "4" }, () => {});
    expect(config.autonomy.maxSteps).toBe(4);
    expect(hardCap).toBe(true);
    const bad = applyAutonomousProfile(config, { maxSteps: "nope" }, () => {});
    expect(bad.hardCap).toBe(false);
    expect(config.autonomy.maxSteps).toBe(4);
  });
});

describe("armAutonomous (the Shift+Tab runtime profile)", () => {
  function hooks(config = defaultConfig()) {
    const calls: { mode: string[]; unattended: object[] } = { mode: [], unattended: [] };
    return {
      calls,
      config,
      deps: {
        config,
        permissions: {
          getMode: () => "plan" as const,
          setMode: (m: string) => calls.mode.push(m),
        },
        engine: {
          setUnattended: (p: object) => calls.unattended.push(p),
        },
      },
    };
  }

  it("arms yolo + both engine switches, and never touches the config", () => {
    const { calls, config, deps } = hooks();
    const before = JSON.stringify(config);
    const { messages } = armAutonomous(deps);
    expect(calls.mode).toEqual(["yolo"]);
    expect(calls.unattended).toEqual([{ verifyPersist: true, autoExtend: true }]);
    expect(messages.join("")).toContain("AUTONOMOUS armed");
    // The whole point of the runtime path: quitting while armed must not
    // persist yolo — so arming may not write a single config field.
    expect(JSON.stringify(config)).toBe(before);
  });

  it("disarm lands on ASK and restores the switches to what the config says", () => {
    const { calls, deps } = hooks();
    const { disarm } = armAutonomous(deps);
    const lines = disarm();
    expect(calls.mode).toEqual(["yolo", "ask"]);
    // Config never had persist/autoExtend on, so restore means false/false.
    expect(calls.unattended[1]).toEqual({ verifyPersist: false, autoExtend: false });
    expect(lines.join("")).toContain("disarmed");
  });

  it("warns about the missing standing gate, and stays quiet when one is configured", () => {
    const bare = armAutonomous(hooks().deps);
    expect(bare.messages.join("")).toContain("no standing verification gate");
    const gatedConfig = defaultConfig();
    gatedConfig.verify = { ...gatedConfig.verify, command: "pnpm -r test" };
    const gated = armAutonomous(hooks(gatedConfig).deps);
    expect(gated.messages.join("")).not.toContain("no standing verification gate");
  });

  it("names the loop-guard gap when the detector was disabled at startup", () => {
    const config = defaultConfig();
    config.loopDetect = { ...config.loopDetect, enabled: false };
    const { messages } = armAutonomous(hooks(config).deps);
    // Unlike --autonomous, the runtime path cannot force the detector on (it is
    // wired at Agent construction) — so it must say the guard is absent.
    expect(messages.join("")).toContain("NO loop guard");
  });
});
