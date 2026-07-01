import { describe, expect, it } from "vitest";
import { defaultMode, hashObservation } from "./mode.js";
import type { ParsedObservation } from "./mode.js";

const SAMPLE = `### Fixed OAuth client_id truncation on Windows
TYPE: bugfix
SUBTITLE: openBrowser dropped the query string via rundll32
FACTS: rundll32 needs the full URL quoted; client_id was lost
NARRATIVE: The login URL was passed to rundll32 unquoted, so the shell split it and dropped client_id. Quoting fixed it.
CONCEPTS: gotcha, problem-solution
FILES_READ: packages/cli/src/main.ts
FILES_MODIFIED: packages/providers/src/oauth.ts

### Added symbol index
TYPE: totally-unknown-type
NARRATIVE: A regex-based symbol extractor cached in sqlite.`;

describe("defaultMode.buildPrompt", () => {
  it("includes the taxonomy and strict block format", () => {
    const prompt = defaultMode.buildPrompt([{ source: "tool", label: "read", text: "hi" }]);
    expect(prompt).toContain("bugfix");
    expect(prompt).toContain("decision");
    expect(prompt).toContain("### <short one-line title>");
    expect(prompt).toContain("NONE");
    expect(prompt).toContain("(tool:read) hi");
  });
});

describe("defaultMode.parse", () => {
  it("parses multiple blocks and clamps unknown types to discovery", () => {
    const parsed = defaultMode.parse(SAMPLE);
    expect(parsed).toHaveLength(2);
    const first = parsed[0];
    expect(first?.type).toBe("bugfix");
    expect(first?.title).toContain("OAuth");
    expect(first?.facts.length).toBe(2);
    expect(first?.concepts).toContain("gotcha");
    expect(first?.filesModified).toEqual(["packages/providers/src/oauth.ts"]);
    // Unknown TYPE clamps to "discovery".
    expect(parsed[1]?.type).toBe("discovery");
    expect(parsed[1]?.facts).toEqual([]);
  });

  it("returns [] for NONE", () => {
    expect(defaultMode.parse("NONE")).toEqual([]);
    expect(defaultMode.parse("  none  ")).toEqual([]);
  });

  it("skips blocks with no title", () => {
    expect(defaultMode.parse("###   \nTYPE: feature")).toEqual([]);
  });
});

describe("hashObservation", () => {
  it("is stable for the same content and project", () => {
    const p: ParsedObservation = {
      type: "feature",
      title: "X",
      facts: [],
      narrative: "n",
      concepts: [],
      filesRead: [],
      filesModified: [],
    };
    expect(hashObservation(p, "proj")).toBe(hashObservation(p, "proj"));
    expect(hashObservation(p, "proj")).not.toBe(hashObservation(p, "other"));
  });
});
