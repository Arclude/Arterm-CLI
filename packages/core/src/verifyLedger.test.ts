import { describe, expect, it } from "vitest";
import {
  VerifyLedger,
  isDocPath,
  normalizeVerifyCommand,
  verifyEvidenceLine,
} from "./verifyLedger.js";

describe("normalizeVerifyCommand", () => {
  // The ledger is keyed on what somebody happened to type. Two spellings of one
  // command must not leave a verified tree looking unverified.
  it("folds `run` out of a package-runner invocation", () => {
    expect(normalizeVerifyCommand("pnpm run test")).toBe("pnpm test");
    expect(normalizeVerifyCommand("pnpm test")).toBe("pnpm test");
    expect(normalizeVerifyCommand("npm run lint")).toBe("npm lint");
  });

  it("sees through a task-runner wrapper", () => {
    expect(normalizeVerifyCommand("uv run pytest")).toBe("pytest");
    expect(normalizeVerifyCommand("poetry run pytest")).toBe("pytest");
    expect(normalizeVerifyCommand("python -m pytest")).toBe("pytest");
    expect(normalizeVerifyCommand("pytest")).toBe("pytest");
  });

  it("reads past workspace flags to the verb", () => {
    expect(normalizeVerifyCommand("pnpm -r test")).toBe("pnpm test");
    expect(normalizeVerifyCommand("pnpm --filter core test")).toBe("pnpm test");
  });

  it("recognizes the non-node runners", () => {
    expect(normalizeVerifyCommand("cargo test")).toBe("cargo test");
    expect(normalizeVerifyCommand("go build")).toBe("go build");
    expect(normalizeVerifyCommand("make check")).toBe("make check");
    expect(normalizeVerifyCommand("tsc --noEmit")).toBe("tsc");
  });

  // Guessing wide is the dangerous direction: a false "verified" is a claim the
  // judge will believe.
  it("refuses anything it does not recognize", () => {
    expect(normalizeVerifyCommand("ls -la")).toBeNull();
    expect(normalizeVerifyCommand("git status")).toBeNull();
    expect(normalizeVerifyCommand("pnpm install")).toBeNull();
    expect(normalizeVerifyCommand("")).toBeNull();
  });

  it("judges only the first statement of a compound line", () => {
    // What the later parts did is not something this can claim to know.
    expect(normalizeVerifyCommand("pnpm test && git commit -m x")).toBe("pnpm test");
    expect(normalizeVerifyCommand("git add -A && pnpm test")).toBeNull();
  });
});

describe("isDocPath", () => {
  it("treats prose as prose", () => {
    expect(isDocPath("README.md")).toBe(true);
    expect(isDocPath("docs/design.mdx")).toBe(true);
    expect(isDocPath(".github/workflows/ci.yml")).toBe(true);
  });

  it("does not exempt code", () => {
    expect(isDocPath("src/markdown.ts")).toBe(false);
    expect(isDocPath("packages/core/src/agent.ts")).toBe(false);
  });
});

describe("VerifyLedger", () => {
  it("says nothing before anything has run", () => {
    expect(new VerifyLedger().state().status).toBe("none");
  });

  it("records a pass and reports its scope", () => {
    const l = new VerifyLedger();
    l.observeCommand("pnpm -r test", 0);
    expect(l.state()).toMatchObject({ status: "passed", command: "pnpm test", scope: "full" });
  });

  // A targeted pass says less than a full one, and a reader told only "passed"
  // would over-read it.
  it("marks a pass over a path as targeted", () => {
    const l = new VerifyLedger();
    l.observeCommand("pytest tests/unit/test_a.py", 0);
    expect(l.state().scope).toBe("targeted");
  });

  // The whole point of the ledger.
  it("goes stale when the tree is edited after a pass", () => {
    const l = new VerifyLedger();
    l.observeCommand("pnpm test", 0);
    l.markEdited(["packages/core/src/agent.ts"]);
    expect(l.state()).toMatchObject({
      status: "stale",
      editedSince: ["packages/core/src/agent.ts"],
    });
  });

  it("a doc-only edit does not invalidate a pass", () => {
    // A check that fires when it should not is one people learn to ignore.
    const l = new VerifyLedger();
    l.observeCommand("pnpm test", 0);
    l.markEdited(["README.md", "docs/x.md"]);
    expect(l.state().status).toBe("passed");
  });

  it("a mixed edit DOES invalidate, and names only the code", () => {
    const l = new VerifyLedger();
    l.observeCommand("pnpm test", 0);
    l.markEdited(["README.md", "src/a.ts"]);
    expect(l.state()).toMatchObject({ status: "stale", editedSince: ["src/a.ts"] });
  });

  // A failure followed by edits is still a failure — the edits are presumably
  // the fix, and "stale" would retire the one status a reader should act on.
  it("does not let an edit downgrade a FAILURE to stale", () => {
    const l = new VerifyLedger();
    l.observeCommand("pnpm test", 1);
    l.markEdited(["src/a.ts"]);
    expect(l.state().status).toBe("failed");
  });

  it("a fresh run clears what was edited before it", () => {
    const l = new VerifyLedger();
    l.observeCommand("pnpm test", 0);
    l.markEdited(["src/a.ts"]);
    l.observeCommand("pnpm test", 0);
    expect(l.state()).toMatchObject({ status: "passed", editedSince: [] });
  });

  it("ignores a command that is not a verification", () => {
    const l = new VerifyLedger();
    l.observeCommand("pnpm test", 0);
    l.observeCommand("git status", 1);
    expect(l.state().status).toBe("passed");
  });
});

describe("verifyEvidenceLine", () => {
  it("says nothing when nothing has run", () => {
    // "not verified" on a run with no suite is an accusation about the absence
    // of something never expected.
    expect(verifyEvidenceLine({ status: "none", editedSince: [] })).toBeUndefined();
  });

  it("states a stale pass as not covering the current tree", () => {
    const line = verifyEvidenceLine({
      status: "stale",
      command: "pnpm test",
      editedSince: ["src/a.ts"],
    });
    expect(line).toContain("src/a.ts");
    expect(line).toContain("does not cover the current tree");
  });

  it("names the failure and that it was never re-run", () => {
    const line = verifyEvidenceLine({ status: "failed", command: "pnpm test", editedSince: [] });
    expect(line).toContain("FAILED");
    expect(line).toContain("not been re-run");
  });

  it("qualifies a targeted pass", () => {
    const line = verifyEvidenceLine({
      status: "passed",
      command: "pytest",
      scope: "targeted",
      editedSince: [],
    });
    expect(line).toContain("not the whole project");
  });

  it("summarizes rather than listing every stale path", () => {
    const many = Array.from({ length: 9 }, (_, i) => `src/f${i}.ts`);
    const line = verifyEvidenceLine({ status: "stale", command: "pnpm test", editedSince: many });
    expect(line).toContain("and 4 more");
  });
});
