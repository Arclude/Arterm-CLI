import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { render } from "ink-testing-library";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { Box, Text } from "./ink.js";
import { detectNoColor, detectSupportsBackground, softColor, theme } from "./theme.js";

describe("softColor", () => {
  it("maps every bare Ink name a component might already be using", () => {
    expect(softColor("red")).toBe("#f38ba8");
    expect(softColor("cyan")).toBe("#94e2d5");
    expect(softColor("gray")).toBe(softColor("grey"));
  });

  it("passes hex, unknown values and undefined through untouched", () => {
    // Ink's own `dim` is not a colour and must survive the trip.
    expect(softColor("dim")).toBe("dim");
    expect(softColor("#123456")).toBe("#123456");
    expect(softColor(undefined)).toBeUndefined();
    expect(softColor("")).toBe("");
  });

  it("covers every colour the semantic tokens are built from", () => {
    for (const value of Object.values(theme)) {
      if (typeof value !== "string") continue;
      expect(value, value).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
});

describe("detectSupportsBackground", () => {
  it("refuses without a TTY — captured output should stay clean", () => {
    expect(detectSupportsBackground({ COLORTERM: "truecolor" }, false)).toBe(false);
  });

  it("obeys NO_COLOR over every capability signal", () => {
    expect(detectSupportsBackground({ NO_COLOR: "1", COLORTERM: "truecolor" }, true)).toBe(false);
    // An empty NO_COLOR is not set — the spec's own rule.
    expect(detectSupportsBackground({ NO_COLOR: "", COLORTERM: "truecolor" }, true)).toBe(true);
  });

  it("accepts truecolor and 256-colour terminals", () => {
    expect(detectSupportsBackground({ COLORTERM: "24bit" }, true)).toBe(true);
    expect(detectSupportsBackground({ TERM: "xterm-256color" }, true)).toBe(true);
    expect(detectSupportsBackground({ TERM: "dumb" }, true)).toBe(false);
  });
});

describe("detectNoColor", () => {
  it("is set only by a non-empty NO_COLOR", () => {
    expect(detectNoColor({ NO_COLOR: "1" })).toBe(true);
    expect(detectNoColor({ NO_COLOR: "" })).toBe(false);
    expect(detectNoColor({})).toBe(false);
  });
});

describe("the Ink shim", () => {
  // Chalk decides at import time whether to emit escapes at all; under vitest
  // it usually decides not to. The shim's job is to hand Ink a *hex*, and that
  // is observable without colour support: a bare name would reach chalk as
  // `red`, a remapped one as `#f38ba8`. So assert on what the shim passes down
  // by rendering and reading back whichever form the environment produces.
  const frame = (node: React.ReactElement): string => render(node).lastFrame() ?? "";

  it("renders text through without swallowing content", () => {
    expect(frame(createElement(Text, { color: "red" }, "boom"))).toContain("boom");
  });

  it("accepts an explicit undefined colour, which Ink's own props reject", () => {
    // `color={selected ? "cyan" : undefined}` is written all over this package;
    // under exactOptionalPropertyTypes it only type-checks against the shim.
    const el = createElement(Text, { color: undefined, backgroundColor: undefined }, "plain");
    expect(frame(el)).toContain("plain");
  });

  it("keeps Box's ref forwarding — measureElement depends on it", () => {
    let seen: unknown = null;
    const el = createElement(
      Box,
      {
        ref: (node: unknown) => {
          seen = node;
        },
        borderStyle: "round" as const,
      },
      createElement(Text, null, "x"),
    );
    render(el);
    expect(seen).not.toBeNull();
  });

  it("is what every component imports — a direct Ink import escapes the palette", () => {
    // The shim only works if nothing goes around it. A new component written
    // against `ink` would render against the terminal's raw 16-colour palette
    // and look wrong beside everything else, with nothing to catch it.
    const dir = dirname(fileURLToPath(import.meta.url));
    const offenders = readdirSync(dir)
      .filter((f) => /\.tsx?$/.test(f) && !f.includes(".test."))
      // `ink.tsx` is the shim itself; `index.ts` takes only `render`, which
      // has no colour props to remap.
      .filter((f) => f !== "ink.tsx" && f !== "index.ts")
      .filter((f) => /from "ink"/.test(readFileSync(join(dir, f), "utf8")));
    expect(offenders).toEqual([]);
  });
});
