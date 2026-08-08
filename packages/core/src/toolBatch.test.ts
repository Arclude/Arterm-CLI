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
