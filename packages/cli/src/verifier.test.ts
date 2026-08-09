import {
  type ArtermConfig,
  type ChatProvider,
  Chronicle,
  VerifyLedger,
  defaultConfig,
} from "@arterm/core";
import { describe, expect, it } from "vitest";
import { createJudgeRun, createVerifier, evidenceBlock, verifyEnabled } from "./verifier.js";

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

  it("runs the configured standing command when the work declared none", async () => {
    // A judge that would pass, and an undeclared goal: before `verify.command`
    // this combination is exactly the hole — nothing runs, and acceptance rests
    // on a reviewer that only reads.
    const cfg = config({ verify: { enabled: true, command: 'node -e "process.exit(7)"' } });
    const verify = createVerifier(deps(judgeProvider({ pass: true, summary: "fine" }), cfg));
    const res = await verify?.({ goal: "add a parser", claim: "added it" });
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

describe("the ledger reaches the judge", () => {
  /** A chronicle with one recorded write, sealed the way a run seals it. */
  const withWrite = (): Chronicle => {
    const chronicle = new Chronicle({ write: () => {} }, () => ({ sessionId: "s" }));
    chronicle.append({
      eventType: "tool.executed",
      outcome: "success",
      scope: { agentId: "r1-1" },
      toolName: "write",
      change: { path: "slug.ts", added: 4, removed: 2, contentHashAfter: "a".repeat(64) },
    });
    return chronicle;
  };

  it("names the file, the counts, the digest and the worker", () => {
    const block = evidenceBlock(withWrite());
    expect(block).toContain("slug.ts");
    expect(block).toContain("+4/-2");
    expect(block).toContain("aaaaaaaaaaaa");
    expect(block).toContain("by r1-1");
  });

  it("says nothing at all when the run wrote nothing", () => {
    // An empty "what was recorded" section reads as "nothing happened", which is
    // false for a review or a question — runs that legitimately write no files.
    expect(evidenceBlock(new Chronicle({ write: () => {} }))).toBeUndefined();
    expect(evidenceBlock(undefined)).toBeUndefined();
  });

  it("adds the verification status, and stands alone without file changes", () => {
    // A run that edited nothing can still have run the tests, so this line is
    // not gated on there being changes to list.
    const ledger = new VerifyLedger();
    ledger.observeCommand("pnpm -r test", 0);
    const block = evidenceBlock(new Chronicle({ write: () => {} }), ledger);
    expect(block).toContain("`pnpm test` passed after the last edit");
  });

  it("reports a pass the run then invalidated", () => {
    // The case the chronicle alone cannot state: a passing result and a
    // worthless one look identical without knowing what happened after it.
    const ledger = new VerifyLedger();
    ledger.observeCommand("pnpm test", 0);
    ledger.markEdited(["slug.ts"]);
    const block = evidenceBlock(withWrite(), ledger);
    expect(block).toContain("slug.ts");
    expect(block).toContain("does not cover the current tree");
  });

  it("stays silent when nothing verifiable ran", () => {
    expect(evidenceBlock(undefined, new VerifyLedger())).toBeUndefined();
  });

  it("counts denied calls, which the claim will not mention", () => {
    const chronicle = withWrite();
    chronicle.append({
      eventType: "tool.denied",
      outcome: "denied",
      scope: {},
      toolName: "bash",
    });
    expect(evidenceBlock(chronicle)).toContain("1 tool call(s) were DENIED");
  });

  it("puts it in the prompt the judge is actually given", async () => {
    // The end of the wire, not the middle: a block built and never rendered
    // would pass every assertion above.
    let prompt = "";
    const provider: ChatProvider = {
      id: "stub",
      supportsNativeTools: () => true,
      listModels: async () => [],
      async *chat(req) {
        prompt = req.messages.map((m) => String(m.content)).join("\n");
        yield {
          type: "tool_call",
          call: { id: "1", name: "submit_verdict", arguments: { pass: true, summary: "ok" } },
        };
        yield { type: "done" };
      },
    };
    const verify = createVerifier({ ...deps(provider), chronicle: withWrite() });
    // `createVerifier` returns undefined when verification is switched off; the
    // default config has it on, so this narrows rather than asserts behaviour.
    if (!verify) throw new Error("verification is on by default");
    await verify({ goal: "g", claim: "I changed nothing." });

    expect(prompt).toContain("WHAT WAS RECORDED");
    expect(prompt).toContain("slug.ts");
    // …and the judge is told what a disagreement means, or the evidence is decoration.
    expect(prompt).toContain("that IS the concrete evidence a rejection needs");
  });
});
