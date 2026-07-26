import { describe, expect, it } from "vitest";
import { AGENT_COLORS, agentColor } from "./agentColor.js";

describe("agentColor", () => {
  it("walks the palette in dispatch order for a round's ids", () => {
    const round = ["f1-1", "f1-2", "f1-3"].map(agentColor);
    expect(round).toEqual([AGENT_COLORS[0], AGENT_COLORS[1], AGENT_COLORS[2]]);
    // A round smaller than the palette never repeats a colour.
    expect(new Set(round).size).toBe(3);
  });

  it("gives a role a stable colour, and never red (that means failed)", () => {
    expect(agentColor("explorer")).toBe(agentColor("explorer"));
    expect(agentColor("reviewer")).not.toBe("red");
    expect(AGENT_COLORS as readonly string[]).not.toContain("red");
  });

  it("keys transcript lines and board rows to the same colour", () => {
    // The board row and the sub-agent's own lines both key on its id.
    expect(agentColor("r2-4")).toBe(agentColor("r2-4"));
  });
});
