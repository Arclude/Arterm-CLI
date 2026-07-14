import { describe, expect, it } from "vitest";
import { defaultConfig, mergeConfig, validateConfigFile } from "./config.js";

describe("mergeConfig", () => {
  it("deep-merges nested blocks so one field doesn't wipe the rest", () => {
    const merged = mergeConfig(defaultConfig(), { memory: { mode: "off" } });
    expect(merged.memory.mode).toBe("off");
    // The block's other defaults must survive.
    expect(merged.memory.maxInject).toBe(12);
    expect(merged.memory.autoDigest).toBe(true);
  });

  it("replaces scalars and leaves untouched blocks at defaults", () => {
    const merged = mergeConfig(defaultConfig(), { temperature: 0.2 });
    expect(merged.temperature).toBe(0.2);
    expect(merged.context).toEqual(defaultConfig().context);
  });

  it("merges two levels deep", () => {
    const merged = mergeConfig(defaultConfig(), {
      session: { maxSessions: 5 },
      fleet: { concurrency: 8 },
    });
    expect(merged.session).toMatchObject({ mode: "jsonl", maxSessions: 5 });
    expect(merged.fleet).toMatchObject({ concurrency: 8, isolation: "none" });
  });
});

describe("validateConfigFile", () => {
  it("passes a valid partial through unchanged", () => {
    const warnings: string[] = [];
    const out = validateConfigFile({ provider: "ollama", mode: "auto" }, (m) => warnings.push(m));
    expect(out).toMatchObject({ provider: "ollama", mode: "auto" });
    expect(warnings).toHaveLength(0);
  });

  it("drops an invalid enum value and warns, keeping valid siblings", () => {
    const warnings: string[] = [];
    const out = validateConfigFile({ mode: "rampage", temperature: 0.5 }, (m) => warnings.push(m));
    expect(out.mode).toBeUndefined();
    expect(out.temperature).toBe(0.5);
    expect(warnings.some((w) => w.includes('"mode"'))).toBe(true);
  });

  it("drops a wrongly-typed nested field but keeps the rest of the block", () => {
    const warnings: string[] = [];
    const out = validateConfigFile({ session: { mode: "jsonl", maxSessions: "lots" } }, (m) =>
      warnings.push(m),
    );
    expect(out.session?.mode).toBe("jsonl");
    expect(out.session?.maxSessions).toBeUndefined();
    expect(warnings.some((w) => w.includes("session.maxSessions"))).toBe(true);
  });

  it("rejects a non-object config file", () => {
    const warnings: string[] = [];
    expect(validateConfigFile("nope", (m) => warnings.push(m))).toEqual({});
    expect(warnings).toHaveLength(1);
  });

  it("lets unknown keys pass through (forward compatibility)", () => {
    const out = validateConfigFile({ someFutureFlag: true }, () => {});
    expect((out as Record<string, unknown>).someFutureFlag).toBe(true);
  });

  it("session persistence defaults to on with a retention cap", () => {
    const cfg = defaultConfig();
    expect(cfg.session.mode).toBe("jsonl");
    expect(cfg.session.maxSessions).toBeGreaterThan(0);
  });
});

describe("team config", () => {
  it("has safe defaults", () => {
    const cfg = defaultConfig();
    expect(cfg.team).toEqual({
      fanout: 4,
      maxRounds: 6,
      isolation: "auto",
      mergeStrategy: "apply",
      suggest: true,
      blackboard: true,
      memory: true,
    });
  });

  it("accepts a valid block and drops invalid fields with a warning", () => {
    const warnings: string[] = [];
    const out = validateConfigFile({ team: { fanout: 2, isolation: "bogus" } }, (m) =>
      warnings.push(m),
    );
    expect(out.team?.fanout).toBe(2);
    expect(out.team?.isolation).toBeUndefined();
    expect(warnings.some((w) => w.includes("team.isolation"))).toBe(true);
  });

  it("merges a partial team block over the defaults without wiping it", () => {
    const merged = mergeConfig(defaultConfig(), { team: { fanout: 2 } });
    expect(merged.team.fanout).toBe(2);
    expect(merged.team.mergeStrategy).toBe("apply");
  });

  it('accepts autonomy mode "team"', () => {
    const out = validateConfigFile({ autonomy: { mode: "team" } }, () => {});
    expect(out.autonomy?.mode).toBe("team");
  });
});
