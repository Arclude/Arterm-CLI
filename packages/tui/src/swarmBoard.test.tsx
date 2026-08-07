import type { SddTaskState } from "@arterm/core";
import { render } from "ink-testing-library";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { TeamBoard, type TeamBoardMember, fmtCost } from "./TeamBoard.js";
import { panelWindow } from "./monitorShell.js";
import { STATE_LABEL, stateMark } from "./taskState.js";

const NOW = 1_000_000;

function member(i: number, state: SddTaskState, extra: Partial<TeamBoardMember> = {}) {
  return {
    id: `w${i}`,
    name: `worker${i}`,
    description: `task ${i}`,
    adhoc: false,
    state,
    task: `task ${i}`,
    ...extra,
  } satisfies TeamBoardMember;
}

function board(members: TeamBoardMember[], props: Record<string, unknown> = {}): string {
  const { lastFrame } = render(
    createElement(TeamBoard, {
      members,
      columns: 120,
      selected: 0,
      detailOpen: false,
      feed: [],
      now: NOW,
      ...props,
    }),
  );
  return lastFrame() ?? "";
}

describe("the swarm board's accounting", () => {
  it("names the leader's spend beside the fleet's rather than folding it in", () => {
    // Totalling only the workers makes a fan-out look cheaper than it was: the
    // planning tokens are the leader's, and they are not free. Two numbers are
    // two facts — "the fleet cost this" and "this run cost that".
    const frame = board([member(1, "running", { cost: 0.02 }), member(2, "done", { cost: 0.03 })], {
      leader: { cost: 0.08 },
    });
    expect(frame).toContain("$0.05");
    expect(frame).toContain("+$0.08 lead");
  });

  it("says nothing about cost when nothing has been priced", () => {
    // A local model costs nothing to run, and `$0.00` on every cell would be a
    // column of noise claiming a measurement nobody made.
    const frame = board([member(1, "running", { tokens: 400 })], { leader: { cost: 0 } });
    expect(frame).not.toContain("$");
    expect(frame).toContain("400t");
  });

  it("prices sub-cent work at a precision that is not zero", () => {
    // A single worker lives in the sub-cent range; `$0.00` reads as free.
    expect(fmtCost(0.0031)).toBe("$0.0031");
    expect(fmtCost(0.42)).toBe("$0.42");
    expect(fmtCost(0)).toBe("");
  });
});

describe("the swarm board's overflow", () => {
  const many = Array.from({ length: 14 }, (_, i) => member(i + 1, "pending"));

  it("counts the agents it cannot draw instead of dropping them", () => {
    // The board lives in the bottom region, which every repaint redraws, so an
    // unbounded grid pushes the transcript off the screen a row at a time. A
    // board showing nine of fourteen and saying nothing reads as the whole swarm.
    const frame = board(many);
    expect(frame).toMatch(/[↑↓] \d+ more agents/);
  });

  it("keeps the selected agent on screen when the selection moves past the window", () => {
    // Cutting the tail is the obvious implementation and the wrong one: the
    // selection scrolls out of view and the arrow keys appear to stop working.
    const frame = board(many, { selected: 13 });
    expect(frame).toContain("worker14");
  });
});

describe("panelWindow", () => {
  const rows = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

  it("returns everything when it all fits", () => {
    const w = panelWindow(rows, 0, 20);
    expect(w.window).toEqual(rows);
    expect(w.before + w.after).toBe(0);
  });

  it("always contains the selection", () => {
    for (let sel = 0; sel < rows.length; sel++) {
      const w = panelWindow(rows, sel, 3);
      expect(w.window, `sel=${sel}`).toContain(sel);
      expect(w.window.length).toBe(3);
    }
  });

  it("never runs off either end, so the window is never short-changed", () => {
    expect(panelWindow(rows, 0, 4).window).toEqual([0, 1, 2, 3]);
    expect(panelWindow(rows, 9, 4).window).toEqual([6, 7, 8, 9]);
  });

  it("reports what it left on both sides", () => {
    const w = panelWindow(rows, 5, 4);
    expect(w.before + w.window.length + w.after).toBe(rows.length);
    expect(w.offset).toBe(w.before);
  });
});

describe("task state vocabulary", () => {
  it("is one table, so two boards cannot disagree about the same state", () => {
    // `running` drew `●` on the swarm board and `▸` on the kanban — same state,
    // same session, two rows apart.
    const states: SddTaskState[] = ["pending", "running", "done", "failed", "blocked"];
    const marks = states.map(stateMark);
    expect(new Set(marks).size).toBe(states.length);
    for (const s of states) expect(STATE_LABEL[s]).toBeTruthy();
  });

  it("spells the state out beside the mark", () => {
    // Colour survives neither a screenshot, nor a colourblind reader, nor a
    // terminal with a palette of its own.
    const frame = board([member(1, "running"), member(2, "failed")]);
    expect(frame).toContain("LIVE");
    expect(frame).toContain("failed");
  });
});
