import { describe, expect, it } from "vitest";
import { displayWidth } from "./terminalWidth.js";
import { glyphSet, resolveIconStyle } from "./uiGlyphs.js";

describe("icon style resolution", () => {
  it("defaults to unicode and accepts the spellings people actually type", () => {
    expect(resolveIconStyle({})).toBe("unicode");
    expect(resolveIconStyle({ ARTERM_TUI_ICON_STYLE: "nerd" })).toBe("nerd");
    expect(resolveIconStyle({ ARTERM_TUI_ICON_STYLE: "nerd-font" })).toBe("nerd");
    expect(resolveIconStyle({ ARTERM_TUI_ICON_STYLE: "NerdFont" })).toBe("nerd");
    expect(resolveIconStyle({ ARTERM_TUI_ICON_STYLE: "ascii" })).toBe("ascii");
    expect(resolveIconStyle({ ARTERM_TUI_ICON_STYLE: "plain" })).toBe("ascii");
  });

  it("falls back to unicode rather than failing on a value it doesn't know", () => {
    expect(resolveIconStyle({ ARTERM_TUI_ICON_STYLE: "emoji" })).toBe("unicode");
    expect(resolveIconStyle({ ARTERM_TUI_ICON_STYLE: "  " })).toBe("unicode");
  });
});

describe("glyph profiles", () => {
  const unicode = glyphSet("unicode");
  const ascii = glyphSet("ascii");
  const nerd = glyphSet("nerd");

  it("defines the same vocabulary in every profile", () => {
    const keys = Object.keys(unicode).sort();
    expect(Object.keys(ascii).sort()).toEqual(keys);
    expect(Object.keys(nerd).sort()).toEqual(keys);
  });

  it("gives the ascii profile no character above the ASCII range", () => {
    // The whole point: a terminal, a pipe or a CI log that renders none of the
    // box-drawing set still gets a readable screen.
    for (const [key, value] of Object.entries(ascii)) {
      expect(value, key).toMatch(/^[\x20-\x7e]+$/);
    }
  });

  it("keeps every unicode state mark to a single column", () => {
    // These sit in padded columns on the boards; a two-column mark shifts the
    // row it is in and nothing else, which reads as a broken table.
    const marks = [
      "success",
      "failure",
      "warning",
      "running",
      "idle",
      "pending",
      "denied",
    ] as const;
    for (const key of marks) {
      expect(displayWidth(unicode[key]), `${key}=${unicode[key]}`).toBe(1);
    }
  });

  it("settles the boards' disagreement about what running looks like", () => {
    // TeamBoard drew `●` and SddBoard drew `▸` for the same state.
    expect(unicode.running).toBe("●");
    expect(unicode.pending).toBe("·");
  });
});
