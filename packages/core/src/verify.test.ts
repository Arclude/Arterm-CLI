import { describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "./eventBus.js";
import {
  type VerdictCapture,
  type Verifier,
  captureVerdict,
  decideVerdict,
  extractVerifyCommand,
  formatVerdictEcho,
  makeCommandVerifier,
  makeCompositeVerifier,
  makeJudgeVerifier,
  normalizeVerdict,
} from "./verify.js";

function toolCall(name: string, args: Record<string, unknown>): AgentEvent {
  return { type: "tool_call", call: { id: "c1", name, arguments: args } };
}

/** `node -e` so the same command works under `sh -c` and `cmd /d /c`. */
const exits = (code: number) => `node -e "process.exit(${code})"`;

describe("extractVerifyCommand", () => {
  it("reads a whole-line marker", () => {
    expect(extractVerifyCommand("verify: pnpm -r test")).toBe("pnpm -r test");
    expect(extractVerifyCommand("$ pnpm test")).toBe("pnpm test");
    expect(extractVerifyCommand("check: tsc --noEmit")).toBe("tsc --noEmit");
    expect(extractVerifyCommand("Verify:   pnpm  test  ")).toBe("pnpm  test");
  });

  it("finds a marker on its own line inside a longer description", () => {
    const desc = [
      "Port the parser.",
      "",
      "Acceptance: nested arrays work",
      "verify: pnpm test",
    ].join("\n");
    expect(extractVerifyCommand(desc)).toBe("pnpm test");
  });

  it("never treats prose as a command", () => {
    // The whole point of the marker: a description that discusses verification
    // must not become a shell invocation. The marker has to OPEN the line — a
    // sentence that happens to contain "verify:" is prose, not a declaration.
    expect(extractVerifyCommand("Please verify: that the parser works")).toBeUndefined();
    expect(
      extractVerifyCommand("You should verify the parser handles nested arrays"),
    ).toBeUndefined();
    expect(extractVerifyCommand("Make sure to check the output carefully")).toBeUndefined();
    expect(extractVerifyCommand("Costs $5 and up")).toBeUndefined();
  });

  it("rejects an empty or punctuation-only body", () => {
    expect(extractVerifyCommand("verify:")).toBeUndefined();
    expect(extractVerifyCommand("verify:   ")).toBeUndefined();
    expect(extractVerifyCommand("$")).toBeUndefined();
    expect(extractVerifyCommand("$ ---")).toBeUndefined();
  });

  it("rejects an absurdly long body", () => {
    expect(extractVerifyCommand(`verify: ${"a".repeat(500)}`)).toBeUndefined();
  });

  it("takes only the first marker, and never more than one line", () => {
    const text = "verify: first\nverify: second";
    expect(extractVerifyCommand(text)).toBe("first");
    expect(extractVerifyCommand(text)).not.toContain("\n");
  });

  it("returns undefined for absent input", () => {
    expect(extractVerifyCommand(undefined)).toBeUndefined();
    expect(extractVerifyCommand("")).toBeUndefined();
  });
});

describe("makeCommandVerifier", () => {
  const verify = makeCommandVerifier({ cwd: process.cwd(), timeoutMs: 20_000 });

  it("is a no-op when nothing declared a command", async () => {
    // A bogus cwd proves no spawn was attempted — it would fail if one were.
    const res = await verify({ goal: "do a thing", claim: "did it", cwd: "/nonexistent-xyz" });
    expect(res).toEqual({ pass: true });
  });

  it("passes on exit 0", async () => {
    const res = await verify({ goal: `verify: ${exits(0)}`, claim: "done" });
    expect(res).toMatchObject({ pass: true, by: "command" });
  });

  it("fails closed on a non-zero exit, naming the code", async () => {
    const res = await verify({ goal: `verify: ${exits(3)}`, claim: "done" });
    expect(res.pass).toBe(false);
    expect(res.by).toBe("command");
    expect(res.reason).toContain("exit 3");
    expect(res.mustFix?.[0]).toContain("must exit 0");
  });

  it("prefers the spec's marker over the goal's", async () => {
    const res = await verify({
      goal: `verify: ${exits(0)}`,
      spec: `verify: ${exits(4)}`,
      claim: "done",
    });
    expect(res.reason).toContain("exit 4");
  });

  it("kills a hung command and fails", async () => {
    const slow = makeCommandVerifier({ cwd: process.cwd(), timeoutMs: 100 });
    const res = await slow({ goal: 'verify: node -e "setTimeout(()=>{},10000)"', claim: "done" });
    expect(res.pass).toBe(false);
    expect(res.reason).toContain("timed out");
  });

  it("lets the shell interpret the command, not Node", async () => {
    // A chain must actually run as a chain. If the whole string were passed as a
    // single argv[0] this would be an unresolvable program name, and if Node
    // interpolated it the metacharacters would be an injection vector.
    const res = await verify({ goal: `verify: ${exits(0)} && ${exits(3)}`, claim: "done" });
    expect(res.pass).toBe(false);
    expect(res.reason).toContain("exit 3");
  });
});

describe("makeCompositeVerifier", () => {
  it("stops at the first failure and skips the rest", async () => {
    const later = vi.fn<Verifier>(async () => ({ pass: true }));
    const composite = makeCompositeVerifier([
      async () => ({ pass: false, reason: "first said no", by: "command" as const }),
      later,
    ]);
    const res = await composite({ goal: "g", claim: "c" });
    expect(res).toMatchObject({ pass: false, reason: "first said no" });
    expect(later).not.toHaveBeenCalled();
  });

  it("passes when every part passes", async () => {
    const composite = makeCompositeVerifier([
      async () => ({ pass: true }),
      async () => ({ pass: true }),
    ]);
    expect(await composite({ goal: "g", claim: "c" })).toEqual({ pass: true });
  });
});

describe("normalizeVerdict", () => {
  it("reads a blocking verdict with its items", () => {
    const v = normalizeVerdict({ pass: false, summary: "no", mustFix: ["a.ts:1 — fix it"] });
    expect(v).toMatchObject({ pass: false, mustFix: ["a.ts:1 — fix it"] });
  });

  it("accepts snake_case must_fix from the JSON tool-call fallback", () => {
    expect(normalizeVerdict({ pass: false, must_fix: ["x"] })?.mustFix).toEqual(["x"]);
  });

  it("still blocks when a rejection names nothing", () => {
    // A rejection must survive sloppiness — it is never upgraded to a pass.
    const v = normalizeVerdict({ pass: false, summary: "the parser is missing" });
    expect(v?.pass).toBe(false);
    expect(v?.mustFix).toEqual(["the parser is missing"]);
  });

  it("never invalidates a verdict over a thin summary", () => {
    // The inverse of a "does this sound vague" check: wording cannot change a verdict.
    expect(normalizeVerdict({ pass: false, summary: "" })?.pass).toBe(false);
    expect(normalizeVerdict({ pass: true, summary: "ok" })?.pass).toBe(true);
  });

  it("accepts a quoted boolean, and nothing else", () => {
    expect(normalizeVerdict({ pass: "true" })?.pass).toBe(true);
    expect(normalizeVerdict({ pass: "FALSE" })?.pass).toBe(false);
    for (const bad of [1, 0, "yes", "no", "PASS", "fail", null, undefined, {}]) {
      expect(normalizeVerdict({ pass: bad })).toBeUndefined();
    }
  });

  it("drops junk from the lists and caps them", () => {
    const v = normalizeVerdict({ pass: false, mustFix: ["  a  ", "", 42, null, "b"] });
    expect(v?.mustFix).toEqual(["a", "b"]);
    const many = normalizeVerdict({
      pass: false,
      mustFix: Array.from({ length: 40 }, (_, i) => `item ${i}`),
    });
    expect(many?.mustFix.length).toBe(20);
  });

  // Each of these is a shape that a Markdown-scraping parser gets wrong. They are
  // regressions against the class of bug this module exists to eliminate.
  it("is immune to verdict words appearing in prose", () => {
    expect(
      normalizeVerdict({
        pass: true,
        summary: "## Verdict (approve / request changes / needs verification)",
      })?.pass,
    ).toBe(true);
    expect(
      normalizeVerdict({ pass: true, summary: "all green, nothing red; 0 tests failed" })?.pass,
    ).toBe(true);
  });

  it("never lets a mustFix entry flip the verdict", () => {
    expect(normalizeVerdict({ pass: true, mustFix: ["- None"] })?.pass).toBe(true);
  });
});

describe("captureVerdict", () => {
  it("takes the verdict off the bus and counts other tool calls as inspection", () => {
    const sink = captureVerdict();
    sink.onEvent(toolCall("read", { path: "a.ts" }));
    sink.onEvent(toolCall("grep", { pattern: "x" }));
    sink.onEvent(
      toolCall("submit_verdict", { pass: false, summary: "nope", mustFix: ["fix a.ts"] }),
    );
    const c = sink.result();
    expect(c.verdict).toMatchObject({ pass: false, mustFix: ["fix a.ts"] });
    expect(c.inspected).toBe(2);
    expect(c.reason).toBeUndefined();
  });

  it("reports a garbage payload as malformed, with no verdict", () => {
    const sink = captureVerdict();
    sink.onEvent(toolCall("submit_verdict", { pass: "maybe" }));
    const c = sink.result();
    expect(c.verdict).toBeUndefined();
    expect(c).toMatchObject({ malformed: 1, reason: "malformed" });
  });

  it("reports nothing submitted", () => {
    const sink = captureVerdict();
    sink.onEvent(toolCall("read", {}));
    const c = sink.result();
    expect(c.verdict).toBeUndefined();
    expect(c.reason).toBe("not-submitted");
  });

  it("keeps the first verdict when a judge calls twice", () => {
    const sink = captureVerdict();
    sink.onEvent(toolCall("submit_verdict", { pass: false, summary: "first" }));
    sink.onEvent(toolCall("submit_verdict", { pass: true, summary: "second" }));
    expect(sink.result().verdict?.summary).toBe("first");
  });

  it("ignores unrelated event types", () => {
    const sink = captureVerdict();
    sink.onEvent({
      type: "assistant_message",
      message: { role: "assistant", content: "submit_verdict pass true" },
    });
    sink.onEvent({ type: "turn_end" });
    const c = sink.result();
    expect(c.verdict).toBeUndefined();
    expect(c.inspected).toBe(0);
  });
});

describe("decideVerdict", () => {
  const bare = { inspected: 1, malformed: 0 };

  it("blocks only on an explicit negative verdict", () => {
    const d = decideVerdict({
      ...bare,
      verdict: { pass: false, summary: "missing parser", mustFix: ["add parser"], refs: [] },
    });
    expect(d).toMatchObject({ pass: false, judged: true, mustFix: ["add parser"] });
  });

  it("accepts an explicit pass", () => {
    const d = decideVerdict({
      ...bare,
      verdict: { pass: true, summary: "looks right", mustFix: [], refs: [] },
    });
    expect(d).toMatchObject({ pass: true, judged: true });
  });

  it("accepts, unjudged, when no verdict arrived", () => {
    const d = decideVerdict({ inspected: 0, malformed: 0, reason: "not-submitted" });
    expect(d.pass).toBe(true);
    expect(d.judged).toBe(false);
    expect(d.feedback).toContain("no reviewer verdict");
  });

  it("accepts, unjudged, when the payload was unreadable", () => {
    const d = decideVerdict({ inspected: 0, malformed: 1, reason: "malformed" });
    expect(d).toMatchObject({ pass: true, judged: false });
    expect(d.feedback).toContain("could not be read");
  });

  it("marks a pass from a judge that opened nothing", () => {
    const d = decideVerdict({
      inspected: 0,
      malformed: 0,
      verdict: { pass: true, summary: "fine", mustFix: [], refs: [] },
    });
    expect(d.pass).toBe(true);
    expect(d.feedback).toContain("inspected nothing");
  });
});

describe("makeJudgeVerifier", () => {
  const req = { goal: "build a parser", claim: "built it" };

  it("fails open when the judge throws", async () => {
    const verify = makeJudgeVerifier({
      run: async () => {
        throw new Error("provider unreachable");
      },
    });
    expect(await verify(req)).toMatchObject({ pass: true, skipped: true, by: "judge" });
  });

  it("fails open when no verdict arrives", async () => {
    const verify = makeJudgeVerifier({
      run: async () => ({ inspected: 0, malformed: 0, reason: "not-submitted" as const }),
    });
    expect(await verify(req)).toMatchObject({ pass: true, skipped: true });
  });

  it("blocks on an explicit rejection and carries the items", async () => {
    const verify = makeJudgeVerifier({
      run: async () => ({
        inspected: 3,
        malformed: 0,
        verdict: { pass: false, summary: "no parser", mustFix: ["add src/parser.ts"], refs: [] },
      }),
    });
    const res = await verify(req);
    expect(res).toMatchObject({ pass: false, by: "judge", mustFix: ["add src/parser.ts"] });
    expect(res.skipped).toBeUndefined();
  });

  it("gives the judge the criteria and the prior fixes to re-check", async () => {
    let prompt = "";
    const verify = makeJudgeVerifier({
      run: async (p) => {
        prompt = p;
        return { inspected: 1, malformed: 0 } satisfies VerdictCapture;
      },
    });
    await verify({ ...req, spec: "parser handles nested arrays" });
    expect(prompt).toContain("build a parser");
    expect(prompt).toContain("parser handles nested arrays");
    expect(prompt).toContain("submit_verdict");
  });
});

describe("formatVerdictEcho", () => {
  it("confirms a usable verdict", () => {
    expect(formatVerdictEcho({ pass: true, summary: "ok" }).output).toContain("PASS");
    expect(formatVerdictEcho({ pass: false, mustFix: ["a", "b"] }).output).toContain("2 item(s)");
  });

  it("names the offending value on a bad payload", () => {
    const echo = formatVerdictEcho({ pass: "maybe" });
    expect(echo.isError).toBe(true);
    expect(echo.output).toContain('"maybe"');
  });
});
