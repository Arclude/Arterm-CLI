import { EventBus } from "@arterm/core";
import { describe, expect, it, vi } from "vitest";
import { runHeadlessGoal } from "./headless.js";

/** Minimal Session stand-in: an autonomy engine that just emits scripted events. */
function fakeSession(bus: EventBus, script: (bus: EventBus) => void) {
  return {
    bus,
    setAsker: () => {},
    permissionMode: "yolo",
    autonomy: {
      start: async () => {
        script(bus);
      },
    },
  } as unknown as Parameters<typeof runHeadlessGoal>[0];
}

describe("runHeadlessGoal", () => {
  it("reports a rejected goal as stopped, with the verdicts that got it there", async () => {
    const bus = new EventBus();
    const session = fakeSession(bus, (b) => {
      b.emit({ type: "autonomy_step", step: 1 });
      b.emit({
        type: "autonomy_verify",
        pass: false,
        by: "command",
        scope: "goal",
        note: "exit 3",
        mustFix: ["make it exit 0"],
      });
      b.emit({ type: "autonomy_stopped", reason: "rejected twice" });
    });

    const res = await runHeadlessGoal(session, "ship it", { json: true });

    expect(res.state).toBe("stopped");
    expect(res.summary).toBe("rejected twice");
    expect(res.steps).toBe(1);
    expect(res.verdicts).toEqual([
      {
        pass: false,
        by: "command",
        scope: "goal",
        // Stated on a verdict that was genuinely reached, not only on one that
        // was skipped: that is the whole point of the field being required.
        skipped: false,
        note: "exit 3",
        mustFix: ["make it exit 0"],
      },
    ]);
  });

  it("says a verdict was REACHED, not merely that it was not skipped", async () => {
    const bus = new EventBus();
    const session = fakeSession(bus, (b) => {
      b.emit({ type: "autonomy_verify", pass: true, by: "judge" });
      b.emit({ type: "autonomy_verify", pass: true, by: "judge", skipped: true });
      b.emit({ type: "autonomy_done", summary: "shipped" });
    });

    const res = await runHeadlessGoal(session, "ship it", { json: true });

    // Both verdicts PASS, and a reader of the document must still be able to
    // tell the reviewed one from the one nobody reviewed. Omitted when false,
    // the second row is what a run with the whole verify layer unwired emits.
    expect(res.verdicts.map((v) => v.skipped)).toEqual([false, true]);
    for (const v of res.verdicts) expect(v).toHaveProperty("skipped");
  });

  it("records an unobtainable verdict as skipped, not as a pass", async () => {
    // The distinction the whole design turns on: accepted-because-unverifiable
    // has to stay tellable apart from verified, including in machine output.
    const bus = new EventBus();
    const session = fakeSession(bus, (b) => {
      b.emit({ type: "autonomy_verify", pass: true, skipped: true, note: "no verdict arrived" });
      b.emit({ type: "autonomy_done", summary: "shipped" });
    });

    const res = await runHeadlessGoal(session, "ship it", { json: true });

    expect(res.state).toBe("done");
    expect(res.verdicts[0]).toMatchObject({ pass: true, skipped: true });
  });

  it("keeps lifecycle on stderr so stdout stays the answer", async () => {
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const bus = new EventBus();
    const session = fakeSession(bus, (b) => {
      b.emit({ type: "autonomy_step", step: 1 });
      b.emit({ type: "autonomy_done", summary: "shipped" });
    });

    await runHeadlessGoal(session, "ship it");

    expect(err.mock.calls.flat().join("")).toContain("step 1");
    expect(out.mock.calls.flat().join("")).toBe("shipped\n");
    out.mockRestore();
    err.mockRestore();
  });

  it("reports what the guards did, so a cut-off run can't read as a clean one", async () => {
    // These reached only the desktop status feed, so `--print --json` described a
    // run the loop detector had killed as if nothing had happened.
    const bus = new EventBus();
    const session = fakeSession(bus, (b) => {
      b.emit({ type: "autonomy_step", step: 1 });
      b.emit({ type: "loop_detected", streak: 3, note: "same tool calls" });
      b.emit({ type: "loop_detected", streak: 4, note: "same tool calls" });
      b.emit({ type: "loop_cut", streak: 5 });
      b.emit({
        type: "autonomy_extended",
        newLimit: 2,
        reason: "progress since the last extension",
      });
      b.emit({ type: "autonomy_stopped", reason: "reached step limit (2)" });
    });

    const res = await runHeadlessGoal(session, "ship it", { json: true });

    expect(res.guards.loopSteers).toBe(2);
    expect(res.guards.loopCuts).toBe(1);
    expect(res.guards.extensions).toEqual([
      { newLimit: 2, reason: "progress since the last extension" },
    ]);
  });

  it("reports quiet guards as zeroes, never as an absent field", async () => {
    // A script asking "was this run cut?" must get an answer from every run, not
    // `undefined` on the healthy ones.
    const bus = new EventBus();
    const session = fakeSession(bus, (b) => {
      b.emit({ type: "autonomy_done", summary: "shipped" });
    });

    const res = await runHeadlessGoal(session, "ship it", { json: true });

    expect(res.guards).toEqual({ loopSteers: 0, loopCuts: 0, extensions: [] });
  });

  it("reports usage with no ceiling configured — an eval harness needs it every run", async () => {
    // `guards.budget` is about a CEILING and is rightly absent without one.
    // Spend is not: a benchmark reports cost for every trial, and "the operator
    // passed --max-usd" is not a fact about what the run consumed.
    const bus = new EventBus();
    const session = fakeSession(bus, (b) => {
      b.emit({ type: "autonomy_done", summary: "shipped" });
    });
    (session as unknown as { budgetState: () => unknown }).budgetState = () => ({
      tokens: 1085,
      usd: 0.02,
      inputTokens: 150,
      outputTokens: 30,
      cacheTokens: 905,
      reported: true,
      breached: false,
      softHits: 0,
      unpriced: false,
    });

    const res = await runHeadlessGoal(session, "ship it", { json: true });

    expect(res.usage).toEqual({
      inputTokens: 150,
      outputTokens: 30,
      cacheTokens: 905,
      totalTokens: 1085,
      usd: 0.02,
      unpriced: false,
      reported: true,
    });
    expect(res.guards.budget).toBeUndefined();
  });

  it("marks an unreported run as reported:false, not as a free one", async () => {
    const bus = new EventBus();
    const session = fakeSession(bus, (b) => {
      b.emit({ type: "autonomy_done", summary: "shipped" });
    });

    const res = await runHeadlessGoal(session, "ship it", { json: true });

    // No budgetState at all (the fake session has none) still yields the block,
    // flagged as unreported — the one reading that can't be mistaken for $0.
    expect(res.usage.reported).toBe(false);
    expect(res.usage.totalTokens).toBe(0);
  });

  it("streams guard activity to stderr in plain mode", async () => {
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const bus = new EventBus();
    const session = fakeSession(bus, (b) => {
      b.emit({ type: "loop_cut", streak: 5 });
      b.emit({
        type: "autonomy_extended",
        newLimit: 9,
        reason: "progress since the last extension",
      });
      b.emit({ type: "autonomy_done", summary: "shipped" });
    });

    await runHeadlessGoal(session, "ship it");

    const text = err.mock.calls.flat().join("");
    expect(text).toContain("loop cut after 5");
    expect(text).toContain("extended to 9");
    err.mockRestore();
  });

  it("refuses an empty goal", async () => {
    const bus = new EventBus();
    await expect(
      runHeadlessGoal(
        fakeSession(bus, () => {}),
        "  ",
      ),
    ).rejects.toThrow(/No goal/);
  });
});
