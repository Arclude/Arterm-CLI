import { type ArtermConfig, type ChatProvider, defaultConfig } from "@arterm/core";
import { describe, expect, it } from "vitest";
import { createJudgeRun, createVerifier, verifyEnabled } from "./verifier.js";

function config(over: Partial<ArtermConfig> = {}): ArtermConfig {
  return { ...defaultConfig(), ...over };
}

/** A provider whose first turn is a scripted tool call, then plain text. */
function judgeProvider(args: Record<string, unknown> | undefined): ChatProvider {
  let calls = 0;
  return {
    id: "stub",
    supportsNativeTools: () => true,
    listModels: async () => [],
    async *chat() {
      calls += 1;
      if (calls === 1 && args) {
        yield { type: "tool_call", call: { id: "1", name: "submit_verdict", arguments: args } };
      } else {
        yield { type: "text", delta: "reviewed" };
      }
      yield { type: "done" };
    },
  };
}

function deps(provider: ChatProvider, cfg = config()) {
  return {
    provider: () => provider,
    model: () => "stub-model",
    tools: () => [],
    context: () => undefined,
    cwd: process.cwd(),
    config: cfg,
  };
}

describe("verifyEnabled", () => {
  it("is on by default", () => {
    expect(verifyEnabled(config())).toBe(true);
  });

  it("honors the superseded autonomy.verify flag", () => {
    const legacy = config({ autonomy: { mode: "once", verify: false } });
    // biome-ignore lint/performance/noDelete: exercising a config that predates the block
    delete (legacy as { verify?: unknown }).verify;
    expect(verifyEnabled(legacy)).toBe(false);
  });

  it("lets the new block win over the old flag", () => {
    expect(
      verifyEnabled(
        config({ autonomy: { mode: "once", verify: false }, verify: { enabled: true } }),
      ),
    ).toBe(true);
  });
});

describe("createJudgeRun", () => {
  it("captures an explicit rejection with its items", async () => {
    const run = createJudgeRun(
      deps(judgeProvider({ pass: false, summary: "no parser", mustFix: ["add src/parser.ts"] })),
    );
    const capture = await run("review this");
    expect(capture.verdict).toMatchObject({ pass: false, mustFix: ["add src/parser.ts"] });
  });

  it("returns no verdict when the judge only writes prose", async () => {
    const capture = await createJudgeRun(deps(judgeProvider(undefined)))("review this");
    expect(capture.verdict).toBeUndefined();
    expect(capture.reason).toBe("not-submitted");
  });

  it("returns no verdict when the provider is dead", async () => {
    // The regression this whole design exists for: a dead key must not read as a
    // rejection. `runSubagent` returns a failure STRING rather than throwing, so
    // a text check scored it as FAIL and stopped the run.
    const dead: ChatProvider = {
      id: "stub",
      supportsNativeTools: () => true,
      listModels: async () => [],
      // biome-ignore lint/correctness/useYield: fails before yielding
      async *chat() {
        throw new Error("/chat/completions failed: 401 quota exhausted");
      },
    };
    const capture = await createJudgeRun(deps(dead))("review this");
    expect(capture.verdict).toBeUndefined();
  });
});

describe("createVerifier", () => {
  it("is undefined when verification is off", () => {
    expect(
      createVerifier(deps(judgeProvider(undefined), config({ verify: { enabled: false } }))),
    ).toBeUndefined();
  });

  it("blocks on a judge rejection", async () => {
    const verify = createVerifier(
      deps(judgeProvider({ pass: false, summary: "missing tests", mustFix: ["cover the parser"] })),
    );
    const res = await verify?.({ goal: "add a parser", claim: "added it" });
    expect(res).toMatchObject({ pass: false, by: "judge", mustFix: ["cover the parser"] });
  });

  it("fails open when the judge delivers nothing", async () => {
    const verify = createVerifier(deps(judgeProvider(undefined)));
    const res = await verify?.({ goal: "add a parser", claim: "added it" });
    expect(res).toMatchObject({ pass: true, skipped: true });
  });

  it("runs the deterministic gate first and never reaches the judge on its failure", async () => {
    // The judge provider would pass; the command must decide before it is asked.
    const verify = createVerifier(deps(judgeProvider({ pass: true, summary: "fine" })));
    const res = await verify?.({
      goal: 'verify: node -e "process.exit(7)"',
      claim: "did the work",
    });
    expect(res).toMatchObject({ pass: false, by: "command" });
    expect(res?.reason).toContain("exit 7");
  });

  it("keeps the free deterministic gate when the judge is switched off", async () => {
    const cfg = config({ verify: { enabled: true, judge: false } });
    const verify = createVerifier(
      deps(judgeProvider({ pass: false, summary: "would block" }), cfg),
    );
    // The judge would have rejected; with judge:false only the command decides.
    const res = await verify?.({ goal: 'verify: node -e "process.exit(0)"', claim: "done" });
    expect(res).toMatchObject({ pass: true, by: "command" });
  });
});
