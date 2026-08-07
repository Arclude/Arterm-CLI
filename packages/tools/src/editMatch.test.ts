import { describe, expect, it } from "vitest";
import { applyRanges, matchEdit, matched, reindent } from "./editMatch.js";

/** Apply an edit through the ladder, or return the failure. */
function edit(
  source: string,
  oldStr: string,
  newStr: string,
  replaceAll = false,
): { text: string; tier: string } | { failed: true } {
  const result = matchEdit(source, oldStr, newStr, replaceAll);
  if (!matched(result)) return { failed: true };
  return { text: applyRanges(source, result.ranges, result.replacement), tier: result.tier };
}

const FILE = [
  "export function greet(name: string) {",
  "  const greeting = `hello ${name}`;",
  "  console.log(greeting);",
  "  return greeting;",
  "}",
  "",
].join("\n");

describe("tier 1 — exact", () => {
  it("replaces a unique exact match", () => {
    const r = edit(FILE, "  return greeting;", "  return greeting.trim();");
    expect(r).toMatchObject({ tier: "exact" });
    expect((r as { text: string }).text).toContain("return greeting.trim();");
  });

  it("refuses an ambiguous match rather than picking one", () => {
    const src = "a();\nb();\na();\n";
    expect(edit(src, "a();", "c();")).toEqual({ failed: true });
  });

  it("replaces every occurrence when asked", () => {
    const src = "a();\nb();\na();\n";
    const r = edit(src, "a();", "c();", true);
    expect((r as { text: string }).text).toBe("c();\nb();\nc();\n");
  });

  it("treats $& and $1 in the replacement as literal text", () => {
    // String.replace would interpret these as patterns and silently corrupt
    // the write — the reason this path uses ranges and slices.
    const r = edit("const x = 1;", "1", "$& + $1");
    expect((r as { text: string }).text).toBe("const x = $& + $1;");
  });
});

describe("tier 2 — trailing whitespace", () => {
  it("matches when the model dropped a trailing space", () => {
    const src = "const a = 1;   \nconst b = 2;\n";
    const r = edit(src, "const a = 1;", "const a = 9;");
    expect(r).toMatchObject({ tier: "exact" }); // substring still matches exactly
    expect((r as { text: string }).text).toContain("const a = 9;");
  });

  it("matches when the model ADDED a trailing space the file does not have", () => {
    const src = "const a = 1;\nconst b = 2;\n";
    const r = edit(src, "const a = 1;  ", "const a = 9;");
    expect(r).toMatchObject({ tier: "trailing-space" });
    expect((r as { text: string }).text).toBe("const a = 9;\nconst b = 2;\n");
  });
});

describe("tier 3 — whitespace normalized", () => {
  it("matches a block the model re-indented", () => {
    // The model remembered the body at two spaces; the file has four.
    const src = "function f() {\n    const a = 1;\n    return a;\n}\n";
    const r = edit(src, "  const a = 1;\n  return a;", "  const a = 2;\n  return a;");
    expect(r).toMatchObject({ tier: "whitespace" });
    // …and the replacement is written at the FILE's indentation, not the
    // model's, or the edit would destroy the block's shape.
    expect((r as { text: string }).text).toBe(
      "function f() {\n    const a = 2;\n    return a;\n}\n",
    );
  });

  it("matches across tabs vs spaces", () => {
    const src = "if (x) {\n\treturn 1;\n}\n";
    const r = edit(src, "    return 1;", "    return 2;");
    expect(r).toMatchObject({ tier: "whitespace" });
    expect((r as { text: string }).text).toContain("return 2;");
  });

  it("refuses when the normalized form appears twice", () => {
    const src = "if (a) {\n  go();\n}\nif (b) {\n  go();\n}\n";
    expect(edit(src, "   go();", "stop();")).toEqual({ failed: true });
  });

  it("never matches on blank lines alone", () => {
    // Whitespace-only lines normalize to "", which would match ANY blank run
    // in the file — the one input the normalized tier has to refuse outright.
    expect(edit("const a = 1;\n\n\nconst b = 2;\n", "   \n  ", "x")).toEqual({ failed: true });
  });
});

describe("tier 4 — block anchor", () => {
  it("matches a block whose interior drifted, anchored on both ends", () => {
    const src = [
      "function compute(a, b) {",
      "  const sum = a + b;",
      "  const scaled = sum * 2;",
      "  return scaled;",
      "}",
      "",
    ].join("\n");
    // The model misremembers the middle line but has the ends right.
    const r = edit(
      src,
      [
        "function compute(a, b) {",
        "  const sum = a + b;",
        "  const scaled = sum * 3;",
        "  return scaled;",
        "}",
      ].join("\n"),
      ["function compute(a, b) {", "  return (a + b) * 2;", "}"].join("\n"),
    );
    expect(r).toMatchObject({ tier: "block-anchor" });
    expect((r as { text: string }).text).toBe(
      "function compute(a, b) {\n  return (a + b) * 2;\n}\n",
    );
  });

  it("refuses when two blocks share the same anchors", () => {
    // The dangerous case: same opening and closing line, different bodies.
    const src = ["if (x) {", "  first();", "}", "if (x) {", "  second();", "}", ""].join("\n");
    expect(edit(src, "if (x) {\n  changed();\n}", "if (x) {\n  done();\n}")).toEqual({
      failed: true,
    });
  });

  it("refuses when the interior is too different to be the same block", () => {
    const src = ["try {", "  const a = readConfigFromDisk();", "} catch {}", ""].join("\n");
    const wrong = ["try {", "  launchTheMissilesAndFormatTheDisk(1, 2, 3);", "} catch {}"].join(
      "\n",
    );
    expect(edit(src, wrong, "try {} catch {}")).toEqual({ failed: true });
  });

  it("does not fire on a two-line block, which is all anchor and no interior", () => {
    const src = "open();\nclose();\n";
    expect(edit(src, "open();\nCLOSE();", "x();")).toEqual({ failed: true });
  });
});

describe("the ladder's safety rules", () => {
  it("keeps replace_all on the exact tiers only", () => {
    // Replacing EVERY approximate match is a much larger blast radius than the
    // caller asked for, so replace_all fails rather than falling down the
    // ladder. Here the file uses tabs and the needle uses spaces: the
    // normalized tier would match, and for replace_all it must not run.
    const src = "if (a) {\n\tgo();\n}\nif (b) {\n\tgo();\n}\n";
    expect(edit(src, "  go();", "stop();", true)).toEqual({ failed: true });
    // The same needle, single-target, is allowed to use the loose tier — but
    // only because it resolves to exactly one place.
    const single = "if (a) {\n\tgo();\n}\n";
    expect(edit(single, "  go();", "  stop();")).toMatchObject({ tier: "whitespace" });
  });

  it("reports which tier matched so a loose match is never silent", () => {
    const src = "function f() {\n    const a = 1;\n    return a;\n}\n";
    const r = matchEdit(src, "  const a = 1;\n  return a;", "  const a = 2;\n  return a;", false);
    expect(matched(r) && r.tier).toBe("whitespace");
  });

  it("says nothing was found when nothing resembles it", () => {
    expect(edit(FILE, "completely unrelated text", "x")).toEqual({ failed: true });
  });
});

describe("reindent", () => {
  it("moves a whole block by the delta of its first line", () => {
    expect(reindent("  a\n    b\n", "\t")).toBe("\ta\n\t  b\n");
  });

  it("leaves blank lines blank rather than padding them", () => {
    expect(reindent("  a\n\n  b\n", "    ")).toBe("    a\n\n    b\n");
  });

  it("is a no-op when the indentation already matches", () => {
    expect(reindent("  a\n  b", "  ")).toBe("  a\n  b");
  });
});
