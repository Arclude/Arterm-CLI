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
        note: "exit 3",
        mustFix: ["make it exit 0"],
      },
    ]);
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
