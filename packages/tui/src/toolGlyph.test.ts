import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { toolColor, toolGlyph, toolVisual } from "./toolGlyph.js";

describe("toolVisual", () => {
  it("gives the tools that do different things different marks", () => {
    // The failure this replaces: every call drew the same `⚙`, so a turn's
    // shape — five reads, one edit, a bash — was invisible until you read.
    const read = toolVisual("read");
    const edit = toolVisual("edit");
    const bash = toolVisual("bash");
    expect(new Set([read.glyph, edit.glyph, bash.glyph]).size).toBe(3);
    expect(new Set([read.color, edit.color, bash.color]).size).toBe(3);
  });

  it("groups tools that mean the same thing", () => {
    expect(toolVisual("edit")).toEqual(toolVisual("multi_edit"));
    expect(toolVisual("grep").glyph).toBe(toolVisual("glob").glyph);
    expect(toolVisual("git")).toEqual(toolVisual("git_commit"));
  });

  it("recognises a tool arriving under an MCP-style namespaced name", () => {
    // The roster is not fixed at build time; servers and plugins add names.
    expect(toolVisual("mcp__files__read")).toEqual(toolVisual("read"));
    expect(toolVisual("read_file")).toEqual(toolVisual("read"));
  });

  it("falls back instead of throwing on a name it has never seen", () => {
    const unknown = toolVisual("wibble_frobnicate");
    expect(unknown.glyph).toBe("•");
    expect(unknown.color).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it("covers every tool the tools package actually ships", () => {
    // A tool added to the registry without a visual renders as the fallback
    // dot and nobody notices; this is the reminder to pick one. The names are
    // read from the sibling package's source rather than imported, because
    // `@arterm/tui` deliberately depends on `core` alone.
    const toolsSrc = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "tools", "src");
    const declared = new Set<string>();
    for (const file of readdirSync(toolsSrc)) {
      if (!file.endsWith(".ts") || file.includes(".test.")) continue;
      for (const m of readFileSync(join(toolsSrc, file), "utf8").matchAll(
        /^\s*name: "([a-z_]+)"/gm,
      )) {
        declared.add(m[1] as string);
      }
    }
    expect(declared.size).toBeGreaterThan(10);

    const fallback = toolVisual("definitely-not-a-tool");
    const uncovered = [...declared].filter((n) => toolVisual(n).glyph === fallback.glyph);
    expect(uncovered).toEqual([]);
  });
});

describe("icon profile", () => {
  it("keeps colour as the identity when glyphs are unavailable", () => {
    // Under `ascii` the glyph collapses; the colour is what still tells a
    // bash from a read, which is why colour is the primary signal.
    const before = process.env.ARTERM_TUI_ICON_STYLE;
    process.env.ARTERM_TUI_ICON_STYLE = "ascii";
    try {
      expect(toolGlyph("read")).toBe(toolGlyph("bash"));
      expect(toolColor("read")).not.toBe(toolColor("bash"));
    } finally {
      // An empty value resolves to `unicode`, same as unset — see resolveIconStyle.
      process.env.ARTERM_TUI_ICON_STYLE = before ?? "";
    }
  });
});
