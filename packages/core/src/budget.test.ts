import { describe, expect, it } from "vitest";
import { RunBudget, priceUsage } from "./budget.js";
import type { CatalogModel } from "./modelsDev.js";

const CATALOG: CatalogModel[] = [
  {
    id: "priced",
    provider: "test",
    inputCost: 3, // $/1M
    outputCost: 15,
    cacheReadCost: 0.3,
    cacheWriteCost: 3.75,
  },
  { id: "no-price", provider: "test" },
];

describe("priceUsage", () => {
  it("prices prompt and completion at their own rates", () => {
    const { usd, tokens } = priceUsage(
      { promptTokens: 1_000_000, completionTokens: 1_000_000 },
      "priced",
      "test",
      CATALOG,
    );
    expect(usd).toBeCloseTo(18, 6);
    expect(tokens).toBe(2_000_000);
  });

  it("prices cached reads at the cache rate, not the input rate", () => {
    // The trap this exists for: an agent loop is mostly cache hits after the
    // first iterations, so charging cache at the input rate overstates a run by
    // close to an order of magnitude. 1M cached reads cost $0.30, not $3.
    const cached = priceUsage(
      // Anthropic shape: the whole prompt was a cache hit, so input_tokens is 0.
      { promptTokens: 0, cacheReadTokens: 1_000_000 },
      "priced",
      "test",
      CATALOG,
    );
    expect(cached.usd).toBeCloseTo(0.3, 6);
    const plain = priceUsage({ promptTokens: 1_000_000 }, "priced", "test", CATALOG);
    expect(plain.usd).toBeCloseTo(3, 6);
    expect(cached.usd * 10).toBeCloseTo(plain.usd, 6);
  });

  it("follows the provider's declared shape instead of guessing it", () => {
    // Same bill, two conventions — and with prompt ≥ cache the numbers alone
    // cannot tell them apart, which is why the provider declares the shape.
    const expected = (100 * 3 + 900 * 0.3) / 1_000_000;

    // OpenAI-compatible: prompt_tokens INCLUDES cached_tokens → subtract.
    const inclusive = priceUsage(
      { promptTokens: 1000, cacheReadTokens: 900, cachedInPrompt: true, completionTokens: 0 },
      "priced",
      "test",
      CATALOG,
    );
    expect(inclusive.usd).toBeCloseTo(expected, 9);

    // Anthropic: input_tokens EXCLUDES cache → bill the prompt in full.
    const exclusive = priceUsage(
      { promptTokens: 100, cacheReadTokens: 900, completionTokens: 0 },
      "priced",
      "test",
      CATALOG,
    );
    expect(exclusive.usd).toBeCloseTo(expected, 9);

    // The failure this pins: reading the inclusive shape as exclusive bills
    // 1000 prompt tokens at the full rate — 5× the real cost.
    const misread = priceUsage(
      { promptTokens: 1000, cacheReadTokens: 900, completionTokens: 0 },
      "priced",
      "test",
      CATALOG,
    );
    expect(misread.usd).toBeGreaterThan(expected * 4);
  });

  it("reports priced=false for a model the catalog does not know", () => {
    // Tokens still count — a local model costs $0 but very much burns tokens.
    const r = priceUsage({ promptTokens: 500, completionTokens: 500 }, "no-price", "test", CATALOG);
    expect(r.usd).toBe(0);
    expect(r.tokens).toBe(1000);
    expect(r.priced).toBe(false);
  });
});

describe("RunBudget", () => {
  const usage = { promptTokens: 1000, completionTokens: 1000, totalTokens: 2000 };

  it("is inactive with no ceiling, so every check is a no-op", () => {
    const b = new RunBudget({ catalog: CATALOG });
    expect(b.inactive).toBe(true);
    b.spend(usage, "priced", "test");
    expect(b.breached).toBe(false);
    expect(b.takeSoftSignal()).toBe(false);
  });

  it("breaches on the token ceiling", () => {
    const b = new RunBudget({ tokens: 3000, catalog: CATALOG });
    b.spend(usage, "priced", "test");
    expect(b.breached).toBe(false);
    b.spend(usage, "priced", "test");
    expect(b.breached).toBe(true);
    expect(b.describe()).toContain("4,000/3,000 tokens");
  });

  it("breaches on the USD ceiling independently of tokens", () => {
    // $0.018 per call at these rates; three calls cross $0.05.
    const b = new RunBudget({ usd: 0.05, catalog: CATALOG });
    b.spend(usage, "priced", "test");
    b.spend(usage, "priced", "test");
    expect(b.breached).toBe(false);
    b.spend(usage, "priced", "test");
    expect(b.breached).toBe(true);
  });

  it("counts tokens even when nothing can be priced — a local model is free, not idle", () => {
    const b = new RunBudget({ tokens: 3000, usd: 999, catalog: CATALOG });
    b.spend(usage, "no-price", "test");
    b.spend(usage, "no-price", "test");
    expect(b.breached).toBe(true);
    expect(b.state().usd).toBe(0);
    // The USD figure is a floor, not a total — say so rather than implying $0.
    expect(b.state().unpriced).toBe(true);
  });

  it("fires the soft signal ONCE, and not at all once breached", () => {
    const b = new RunBudget({ tokens: 4000, softRatio: 0.5, catalog: CATALOG });
    b.spend(usage, "priced", "test"); // 2000 = 50%
    expect(b.takeSoftSignal()).toBe(true);
    // Latched: repeating the wrap-up every iteration would spend the very budget
    // it is trying to preserve.
    expect(b.takeSoftSignal()).toBe(false);
    b.spend(usage, "priced", "test");
    expect(b.breached).toBe(true);
    expect(b.takeSoftSignal()).toBe(false);
  });

  it("child() shares the parent counter by default, so a fleet cannot multiply the bill", () => {
    const parent = new RunBudget({ tokens: 3000, catalog: CATALOG });
    const worker = parent.child();
    expect(worker).toBe(parent);
    worker.spend(usage, "priced", "test");
    worker.spend(usage, "priced", "test");
    expect(parent.breached).toBe(true);
  });

  it("child(own) accounts separately, and its breach does not stop the parent", () => {
    const parent = new RunBudget({ tokens: 100_000, catalog: CATALOG });
    const worker = parent.child({ tokens: 3000 });
    expect(worker).not.toBe(parent);
    worker.spend(usage, "priced", "test");
    worker.spend(usage, "priced", "test");
    expect(worker.breached).toBe(true);
    expect(parent.breached).toBe(false);
    expect(parent.state().tokens).toBe(0);
  });

  it("reports its ceilings so a run can be read without knowing the config", () => {
    const b = new RunBudget({ tokens: 5000, usd: 1, catalog: CATALOG });
    b.spend(usage, "priced", "test");
    const s = b.state();
    expect(s).toMatchObject({ tokens: 2000, limitTokens: 5000, limitUsd: 1, breached: false });
    expect(s.usd).toBeCloseTo(0.018, 6);
  });
});

// The clock is injected rather than slept on: a test that waits for a real
// deadline is a slow test that still cannot pin the boundary exactly.
describe("RunBudget wall-clock ceiling (what a harness takes away)", () => {
  function clock() {
    let t = 1_000_000;
    return {
      now: () => t,
      advance: (sec: number) => {
        t += sec * 1000;
      },
    };
  }

  it("a time ceiling alone makes the budget active", () => {
    const c = clock();
    const b = new RunBudget({ seconds: 100, now: c.now });
    expect(b.inactive).toBe(false);
    expect(b.remainingSec).toBe(100);
  });

  it("breaches on elapsed time with nothing spent", () => {
    const c = clock();
    const b = new RunBudget({ seconds: 100, now: c.now });
    c.advance(99);
    expect(b.breached).toBe(false);
    c.advance(2);
    expect(b.breached).toBe(true);
    expect(b.describe()).toContain("101s/100s elapsed");
  });

  it("enters the reserve phase at the soft ratio and STAYS there", () => {
    const c = clock();
    const b = new RunBudget({ seconds: 100, softRatio: 0.75, now: c.now });
    expect(b.inReservePhase).toBe(false);
    c.advance(76);
    expect(b.inReservePhase).toBe(true);
    // Unlike takeSoftSignal this is a state, not a latched event: a phase the
    // model was told about once is one it has forgotten ten turns later.
    expect(b.inReservePhase).toBe(true);
    expect(b.takeSoftSignal()).toBe(true);
    expect(b.takeSoftSignal()).toBe(false);
  });

  it("remaining time floors at zero rather than going negative", () => {
    const c = clock();
    const b = new RunBudget({ seconds: 10, now: c.now });
    c.advance(50);
    expect(b.remainingSec).toBe(0);
  });

  // A fresh `seconds` per worker would hand each one the whole allowance again
  // while the harness clock ran exactly once.
  it("a child inherits the time LEFT, not a fresh allowance", () => {
    const c = clock();
    const parent = new RunBudget({ seconds: 100, now: c.now });
    c.advance(60);
    const child = parent.child({ tokens: 500 });
    expect(child.remainingSec).toBe(40);
    c.advance(41);
    expect(child.breached).toBe(true);
  });

  it("a child with no ceilings of its own shares the parent outright", () => {
    const c = clock();
    const parent = new RunBudget({ seconds: 100, now: c.now });
    expect(parent.child()).toBe(parent);
  });

  it("reports elapsed seconds even with no ceiling configured", () => {
    const c = clock();
    const b = new RunBudget({ now: c.now });
    c.advance(12.5);
    expect(b.state().elapsedSec).toBeCloseTo(12.5, 3);
    expect(b.state().limitSeconds).toBeUndefined();
  });
});

describe("RunBudget usage split (what an evaluation harness reads)", () => {
  const CAT = CATALOG;

  it("accumulates input/output/cache verbatim, not derived from the priced total", () => {
    const b = new RunBudget({ catalog: CAT });
    b.spend(
      { promptTokens: 100, completionTokens: 20, cacheReadTokens: 900, cacheWriteTokens: 5 },
      "priced",
      "test",
    );
    b.spend({ promptTokens: 50, completionTokens: 10 }, "priced", "test");
    const s = b.state();
    expect(s.inputTokens).toBe(150);
    expect(s.outputTokens).toBe(30);
    expect(s.cacheTokens).toBe(905);
    // The priced total prices cache at its own rate and is a different number
    // on purpose: it is what a ceiling compares against, not a usage report.
    expect(s.tokens).toBe(1085);
  });

  it("reports the split with no ceiling configured — spend is not conditional on a limit", () => {
    const b = new RunBudget({ catalog: CAT });
    expect(b.inactive).toBe(true);
    b.spend({ promptTokens: 7, completionTokens: 3 }, "priced", "test");
    expect(b.state()).toMatchObject({ inputTokens: 7, outputTokens: 3, reported: true });
  });

  it("says 'not reported' rather than 'nothing spent' when the backend counts nothing", () => {
    // Most local servers report no usage at all. An all-zero row that claims to
    // be a cost is the same lie the context gauge told before it stopped
    // trusting reported usage alone.
    const b = new RunBudget({ catalog: CAT });
    b.spend({}, "priced", "test");
    const s = b.state();
    expect(s.reported).toBe(false);
    expect(s.inputTokens).toBe(0);
    expect(s.tokens).toBe(0);
  });

  it("counts a zero-token report as reported — the backend did answer", () => {
    const b = new RunBudget({ catalog: CAT });
    b.spend({ promptTokens: 0, completionTokens: 0 }, "priced", "test");
    expect(b.state().reported).toBe(true);
  });
});
