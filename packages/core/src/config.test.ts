import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { configDelta, defaultConfig, mergeConfig, validateConfigFile } from "./config.js";

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

  it("confines shell commands by default, in every mode", () => {
    // A policy decision, pinned: the sandbox used to be off for attended
    // sessions on the argument that the permission prompt is the control there.
    // It answers a different question — "yes, run `pnpm test`" is not consent to
    // write outside the project — so the boundary is now unconditional and only
    // the response to an UNAVAILABLE one still depends on who is watching.
    const cfg = defaultConfig();
    expect(cfg.sandbox?.enabled).toBe(true);
    // Deny-all is the stronger boundary and the wrong default: a run that cannot
    // reach a registry fails on its first install, and a sandbox people switch
    // off is worth less than a narrower one they leave on.
    expect(cfg.sandbox?.allowedDomains?.length).toBeGreaterThan(0);
    // SSH is the one allowlisted protocol that carries a push.
    expect(cfg.sandbox?.deniedDomains).toContain("*:22");
    // NOT set here: an attended session whose boundary cannot be established
    // warns and continues. `resolveSandbox` derives it from `unattended`.
    expect(cfg.sandbox?.failIfUnavailable).toBeUndefined();
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

describe("configDelta (what the config FILE carries)", () => {
  it("is empty for an untouched config", () => {
    // The whole point in one line: a config nobody edited asserts nothing, so
    // every later release's defaults reach it.
    expect(configDelta(defaultConfig() as never)).toEqual({});
  });

  it("round-trips: merge(defaults, delta(cfg)) reproduces cfg", () => {
    const cfg = defaultConfig();
    cfg.provider = "openai-compat";
    cfg.model = "glm-5.2";
    cfg.openaiCompatHost = "https://api.example.test/v1";
    cfg.context = { ...cfg.context, window: 200_000 };
    cfg.sandbox = { ...cfg.sandbox, allowWrite: ["/somewhere/else"] };
    cfg.permissions = { bash: "allow" } as never;
    const delta = configDelta(cfg as never);
    expect(mergeConfig(defaultConfig(), delta)).toEqual(cfg);
  });

  it("keeps a nested difference and prunes the block around it", () => {
    const cfg = defaultConfig();
    cfg.sandbox = { ...cfg.sandbox, allowWrite: ["/extra"] };
    const delta = configDelta(cfg as never);
    // Only the difference: the untouched allowlist and denylist fall away, so
    // a later change to DEFAULT_ALLOWED_DOMAINS reaches this user.
    expect(delta).toEqual({ sandbox: { allowWrite: ["/extra"] } });
  });

  it("treats arrays as atomic — an edited list survives whole", () => {
    const cfg = defaultConfig();
    cfg.sandbox = {
      ...cfg.sandbox,
      allowedDomains: [...(cfg.sandbox?.allowedDomains ?? []), "internal.example"],
    };
    const delta = configDelta(cfg as never) as { sandbox?: { allowedDomains?: string[] } };
    expect(delta.sandbox?.allowedDomains).toContain("internal.example");
    expect(delta.sandbox?.allowedDomains?.length).toBe(
      (defaultConfig().sandbox?.allowedDomains?.length ?? 0) + 1,
    );
  });

  it("keeps unknown keys, which have no default to equal", () => {
    const delta = configDelta({ ...defaultConfig(), someFutureFlag: true } as never);
    expect((delta as Record<string, unknown>).someFutureFlag).toBe(true);
  });

  it("un-pins yesterday's default so tomorrow's can apply", () => {
    // The sandbox.enabled incident as a law. A file that pinned the OLD default
    // (equal to today's) is dropped by the delta — so when a release changes
    // the default, the merge picks the new one up. Full-persist froze it.
    const pinnedYesterday = defaultConfig(); // value equals the current default
    const delta = configDelta(pinnedYesterday as never);
    const tomorrow = defaultConfig();
    tomorrow.sandbox = { ...tomorrow.sandbox, enabled: false };
    expect(mergeConfig(tomorrow, delta).sandbox?.enabled).toBe(false);
  });

  it("still preserves an explicit choice that DIFFERS from the default", () => {
    const cfg = defaultConfig();
    cfg.sandbox = { ...cfg.sandbox, enabled: false };
    const delta = configDelta(cfg as never);
    expect(mergeConfig(defaultConfig(), delta).sandbox?.enabled).toBe(false);
  });
});

describe("saveConfig writes the delta, loadConfig restores the whole", () => {
  it("round-trips through the real file, carrying only what differs", async () => {
    // Uses the vitest ARTERM_HOME redirect — CONFIG_PATH is resolved from it at
    // module load, which is the same mechanism the isolation guard protects.
    const { loadConfig, saveConfig } = await import("./config.js");
    const cfg = defaultConfig();
    cfg.provider = "openai-compat";
    cfg.model = "glm-5.2";
    await saveConfig(cfg);

    const home = process.env.ARTERM_HOME as string;
    const onDisk = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
    // The file asserts the two chosen values and nothing else: no pinned
    // sandbox block, no context window, no allowlist copied out of defaults.
    expect(onDisk).toEqual({ provider: "openai-compat", model: "glm-5.2" });

    // And the load path reproduces the full resolved config from that delta.
    expect(await loadConfig()).toEqual(cfg);
  });
});
