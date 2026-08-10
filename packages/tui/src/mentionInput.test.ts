import { describe, expect, it } from "vitest";
import { applyMention, filterCandidates, mentionQuery, movePick } from "./mentionInput.js";

describe("mentionQuery", () => {
  it("reports the query while a mention is open", () => {
    expect(mentionQuery("summarize @pack")).toBe("pack");
  });

  it("reports an empty query for a bare @", () => {
    // Distinct from undefined, and the difference is the whole feature: `""`
    // opens the picker on everything, `undefined` means no picker at all.
    expect(mentionQuery("summarize @")).toBe("");
  });

  it("closes as soon as the token ends", () => {
    expect(mentionQuery("summarize @src/a.ts ")).toBeUndefined();
    expect(mentionQuery("summarize @src/a.ts and")).toBeUndefined();
  });

  it("does not open on an email or an scp target", () => {
    // A picker appearing over what someone is writing, because they typed an
    // address, is worse than no picker.
    expect(mentionQuery("mail info@arclude")).toBeUndefined();
    expect(mentionQuery("push to git@github")).toBeUndefined();
  });

  it("opens at the start of a line", () => {
    expect(mentionQuery("@READ")).toBe("READ");
  });
});

describe("filterCandidates", () => {
  const files = [
    "packages/core/src/agent.ts",
    "packages/tui/src/agentColor.ts",
    "agent-notes/README.md",
    "packages/cli/src/main.ts",
  ];

  it("returns everything for an empty query", () => {
    expect(filterCandidates("", files)).toEqual(files);
  });

  it("puts a FILE-NAME hit above a directory hit", () => {
    // Typing `agent` means the file. Ranking the directory first is how a picker
    // stops being usable with Enter.
    expect(filterCandidates("agent", files)[0]).toBe("packages/core/src/agent.ts");
  });

  it("breaks a tie on the shorter path", () => {
    const both = ["vendor/copy/src/app.ts", "src/app.ts"];
    expect(filterCandidates("app.ts", both)[0]).toBe("src/app.ts");
  });

  it("matches without regard to case", () => {
    expect(filterCandidates("AGENT", files)).toContain("packages/core/src/agent.ts");
  });

  it("returns nothing rather than everything when nothing matches", () => {
    expect(filterCandidates("zzzz", files)).toEqual([]);
  });

  it("honours the limit", () => {
    expect(filterCandidates("", files, 2)).toHaveLength(2);
  });
});

describe("applyMention", () => {
  it("replaces the open query and closes the token", () => {
    // The trailing space both ends the picker and separates the path from
    // whatever is typed next.
    expect(applyMention("summarize @pack", "packages/core/src/agent.ts")).toBe(
      "summarize @packages/core/src/agent.ts ",
    );
  });

  it("completes a bare @", () => {
    expect(applyMention("look at @", "a.ts")).toBe("look at @a.ts ");
  });

  it("quotes a path with a space in it", () => {
    // Unquoted, `extractMentions` would read it to the first space and hand back
    // half a path — a picker inserting something the reader cannot parse.
    expect(applyMention("read @my", "my notes.md")).toBe('read @"my notes.md" ');
  });

  it("leaves a line with no open mention alone", () => {
    expect(applyMention("nothing here", "a.ts")).toBe("nothing here");
  });
});

describe("movePick", () => {
  it("wraps at both ends", () => {
    // Clamping would make the key silently do nothing at the bottom, and in a
    // box with no scrollbar that is indistinguishable from a frozen picker.
    expect(movePick(0, -1, 3)).toBe(2);
    expect(movePick(2, 1, 3)).toBe(0);
  });

  it("stays at zero with nothing to pick", () => {
    expect(movePick(0, 1, 0)).toBe(0);
  });
});
