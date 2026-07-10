import { describe, expect, it } from "vitest";
import { FEED_CAP, appendFeed, formatMemberEvent } from "./teamFeed.js";

describe("formatMemberEvent", () => {
  it("formats tool calls with truncated args", () => {
    const line = formatMemberEvent({
      type: "tool_call",
      call: {
        id: "1",
        name: "edit",
        arguments: { path: "src/util.js", old_string: "x".repeat(200) },
      },
    });
    expect(line).toContain("⚙ edit");
    expect(line).toContain("…");
    expect((line ?? "").length).toBeLessThan(90);
  });

  it("formats results with an ok/error marker and flattened whitespace", () => {
    const ok = formatMemberEvent({
      type: "tool_result",
      callId: "1",
      name: "write",
      output: "Wrote 413 bytes\nto README.md",
      isError: false,
    });
    expect(ok).toBe("└ ✓ Wrote 413 bytes to README.md");
    const err = formatMemberEvent({
      type: "tool_result",
      callId: "2",
      name: "edit",
      output: "old_string not found in file.",
      isError: true,
    });
    expect(err).toContain("└ ✗");
  });

  it("formats messages, denials, and errors; skips empty messages and unknown events", () => {
    expect(
      formatMemberEvent({
        type: "assistant_message",
        message: { role: "assistant", content: "Done with the README." },
      }),
    ).toBe("✎ Done with the README.");
    expect(
      formatMemberEvent({
        type: "assistant_message",
        message: { role: "assistant", content: "  " },
      }),
    ).toBeUndefined();
    expect(
      formatMemberEvent({ type: "tool_denied", callId: "3", name: "bash", reason: "blocked" }),
    ).toContain("⊘ bash denied");
    expect(formatMemberEvent({ type: "error", error: "boom" })).toBe("✗ boom");
    expect(formatMemberEvent({ type: "turn_start" })).toBeUndefined();
  });
});

describe("appendFeed", () => {
  it("appends immutably and caps the ring", () => {
    let feed: string[] | undefined;
    for (let i = 0; i < FEED_CAP + 10; i++) feed = appendFeed(feed, `line ${i}`);
    expect(feed).toHaveLength(FEED_CAP);
    expect(feed?.[0]).toBe("line 10");
    expect(feed?.at(-1)).toBe(`line ${FEED_CAP + 9}`);
  });
});
