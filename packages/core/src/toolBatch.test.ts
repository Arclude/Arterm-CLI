import { describe, expect, it } from "vitest";
import { MAX_CONCURRENT_TOOLS, planToolBatches } from "./toolBatch.js";
import type { ToolCall } from "./types.js";

const call = (name: string): ToolCall => ({ id: name, name, arguments: {} });
const names = (batches: ToolCall[][]) => batches.map((b) => b.map((c) => c.name));
/** Everything named `read*` is concurrency-safe; nothing else is. */
const safe = (c: ToolCall) => c.name.startsWith("read");

describe("planToolBatches", () => {
  it("collapses consecutive safe calls into one batch", () => {
    const batches = planToolBatches([call("read1"), call("read2"), call("read3")], safe);
    expect(names(batches)).toEqual([["read1", "read2", "read3"]]);
  });

  it("gives every unsafe call a batch of its own", () => {
    const batches = planToolBatches([call("write1"), call("write2")], safe);
    expect(names(batches)).toEqual([["write1"], ["write2"]]);
  });

  it("keeps the model's order instead of hoisting the cheap calls forward", () => {
    // The failure this forecloses: reads pulled ahead of the edit they were
    // meant to follow, so a tool observes a file before the write that was
    // supposed to precede it. Runs, not a partition.
    const batches = planToolBatches(
      [call("read1"), call("read2"), call("write"), call("read3"), call("read4")],
      safe,
    );
    expect(names(batches)).toEqual([["read1", "read2"], ["write"], ["read3", "read4"]]);
  });

  it("caps a batch's width and continues in the next one", () => {
    const calls = Array.from({ length: MAX_CONCURRENT_TOOLS + 2 }, (_, i) => call(`read${i}`));
    const batches = planToolBatches(calls, safe);
    expect(batches[0]).toHaveLength(MAX_CONCURRENT_TOOLS);
    expect(batches[1]).toHaveLength(2);
    // Nothing is dropped by the cap — a silently truncated turn would leave
    // tool_calls with no matching result, which native APIs reject.
    expect(batches.flat()).toHaveLength(calls.length);
  });

  it("asks the policy exactly once per call", () => {
    // `safe` consults the permission ladder, which builds a decision trace.
    // Asking twice would double every trace an inspector prints.
    const asked: string[] = [];
    planToolBatches([call("read1"), call("read2"), call("write")], (c) => {
      asked.push(c.name);
      return safe(c);
    });
    expect(asked).toEqual(["read1", "read2", "write"]);
  });

  it("yields nothing for no calls", () => {
    expect(planToolBatches([], safe)).toEqual([]);
  });
});

/**
 * Admission by the paths a CALL touches rather than by a flag on its TOOL.
 * A bare `true` still means "reserves nothing", so everything above is
 * unchanged; these cover what a reservation buys and what it must refuse.
 */
describe("planToolBatches path reservations", () => {
  const reserve =
    (map: Record<string, { reads?: string[]; writes?: string[] } | null>) => (c: ToolCall) => {
      const r = map[c.name];
      if (r === undefined) return false;
      if (r === null) return null;
      return { reads: r.reads ?? [], writes: r.writes ?? [] };
    };

  it("runs two writes to different files together", () => {
    // The whole point: the static per-tool flag cannot express this, because
    // "is this tool a writer" is the wrong question.
    const batches = planToolBatches(
      [call("w-a"), call("w-b")],
      reserve({ "w-a": { writes: ["/p/a.ts"] }, "w-b": { writes: ["/p/b.ts"] } }),
    );
    expect(names(batches)).toEqual([["w-a", "w-b"]]);
  });

  it("separates two writes to the SAME file", () => {
    const batches = planToolBatches(
      [call("w1"), call("w2")],
      reserve({ w1: { writes: ["/p/a.ts"] }, w2: { writes: ["/p/a.ts"] } }),
    );
    expect(names(batches)).toEqual([["w1"], ["w2"]]);
  });

  it("keeps reader↔reader overlap parallel", () => {
    const batches = planToolBatches(
      [call("r1"), call("r2")],
      reserve({ r1: { reads: ["/p/a.ts"] }, r2: { reads: ["/p/a.ts"] } }),
    );
    expect(names(batches)).toEqual([["r1", "r2"]]);
  });

  it("separates a read from a write of the same file, in both orders", () => {
    const wr = reserve({ w: { writes: ["/p/a.ts"] }, r: { reads: ["/p/a.ts"] } });
    expect(names(planToolBatches([call("w"), call("r")], wr))).toEqual([["w"], ["r"]]);
    expect(names(planToolBatches([call("r"), call("w")], wr))).toEqual([["r"], ["w"]]);
  });

  // A directory reservation (a search root) has to conflict with the files
  // under it, or a tree search runs beside a write into that tree.
  it("treats a directory as overlapping the files beneath it", () => {
    const batches = planToolBatches(
      [call("scan"), call("w")],
      reserve({ scan: { reads: ["/p/src"] }, w: { writes: ["/p/src/a.ts"] } }),
    );
    expect(names(batches)).toEqual([["scan"], ["w"]]);
  });

  it("does not confuse a sibling directory with a prefix of its name", () => {
    const batches = planToolBatches(
      [call("scan"), call("w")],
      reserve({ scan: { reads: ["/p/src"] }, w: { writes: ["/p/src-gen/a.ts"] } }),
    );
    expect(names(batches)).toEqual([["scan", "w"]]);
  });

  // Unknown is not harmless. A reservation is a claim read off the arguments,
  // and a call that cannot make the claim has not made it.
  it("makes an unreadable reservation a barrier", () => {
    const batches = planToolBatches(
      [call("r1"), call("mystery"), call("r2")],
      reserve({ r1: { reads: ["/p/a"] }, mystery: null, r2: { reads: ["/p/b"] } }),
    );
    expect(names(batches)).toEqual([["r1"], ["mystery"], ["r2"]]);
  });

  // Still RUNS, not a partition: a conflicting call opens the next batch where
  // it stands, and a later compatible call must not be hoisted back over it.
  it("closes the run on a conflict instead of skipping the call forward", () => {
    const batches = planToolBatches(
      [call("r-a"), call("w-a"), call("r-b")],
      reserve({
        "r-a": { reads: ["/p/a.ts"] },
        "w-a": { writes: ["/p/a.ts"] },
        "r-b": { reads: ["/p/b.ts"] },
      }),
    );
    expect(names(batches)).toEqual([["r-a"], ["w-a", "r-b"]]);
  });

  it("accumulates claims across a whole batch, not just its last member", () => {
    const batches = planToolBatches(
      [call("w-a"), call("w-b"), call("r-a")],
      reserve({
        "w-a": { writes: ["/p/a.ts"] },
        "w-b": { writes: ["/p/b.ts"] },
        // Conflicts with the FIRST member, which a last-member check would miss.
        "r-a": { reads: ["/p/a.ts"] },
      }),
    );
    expect(names(batches)).toEqual([["w-a", "w-b"], ["r-a"]]);
  });

  it("lets a bare true share a batch with a reservation", () => {
    const batches = planToolBatches([call("plain"), call("w")], (c) =>
      c.name === "plain" ? true : { reads: [], writes: ["/p/a.ts"] },
    );
    expect(names(batches)).toEqual([["plain", "w"]]);
  });
});
