import { describe, expect, it } from "vitest";
import { OSC52_MAX_CHARS, osc52Sequence } from "./clipboard.js";

const PREFIX = "]52;c;";
const BEL = "";

describe("osc52Sequence", () => {
  it("wraps base64 utf-8 text in an OSC 52 clipboard sequence", () => {
    const seq = osc52Sequence("merhaba ✓");
    expect(seq.startsWith(PREFIX)).toBe(true);
    expect(seq.endsWith(BEL)).toBe(true);
    const b64 = seq.slice(PREFIX.length, -1);
    expect(Buffer.from(b64, "base64").toString("utf8")).toBe("merhaba ✓");
  });

  it("caps oversized payloads", () => {
    const seq = osc52Sequence("x".repeat(OSC52_MAX_CHARS + 5000));
    const b64 = seq.slice(PREFIX.length, -1);
    expect(Buffer.from(b64, "base64").toString("utf8")).toHaveLength(OSC52_MAX_CHARS);
  });
});
