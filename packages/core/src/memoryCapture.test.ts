import { describe, expect, it } from "vitest";
import { EventBus } from "./eventBus.js";
import type { MemoryRecord } from "./memory.js";
import {
  MemoryRecorder,
  buildDigestPrompt,
  digest,
  formatMemorySection,
  parseLearnings,
} from "./memoryCapture.js";

describe("MemoryRecorder", () => {
  it("captures tool results, assistant messages, and goals from the bus", () => {
    const bus = new EventBus();
    const rec = new MemoryRecorder();
    rec.attach(bus);

    bus.emit({ type: "goal_set", goal: "ship it", mode: "once" });
    bus.emit({
      type: "tool_result",
      callId: "1",
      name: "read",
      output: "file body",
      isError: false,
    });
    bus.emit({ type: "assistant_message", message: { role: "assistant", content: "thinking" } });
    bus.emit({ type: "tool_result", callId: "2", name: "ls", output: "   ", isError: false }); // empty → skipped

    const obs = rec.observations();
    expect(obs.map((o) => o.label)).toEqual(["goal", "read", "assistant"]);
  });

  it("clear empties the buffer", () => {
    const bus = new EventBus();
    const rec = new MemoryRecorder();
    rec.attach(bus);
    bus.emit({ type: "tool_result", callId: "1", name: "read", output: "x", isError: false });
    rec.clear();
    expect(rec.observations()).toEqual([]);
  });

  it("detach stops capturing", () => {
    const bus = new EventBus();
    const rec = new MemoryRecorder();
    rec.attach(bus);
    rec.detach();
    bus.emit({ type: "tool_result", callId: "1", name: "read", output: "x", isError: false });
    expect(rec.observations()).toEqual([]);
  });
});

describe("MemoryRecorder.setAutoFlush", () => {
  const emitTool = (bus: EventBus, n: number) => {
    for (let i = 0; i < n; i++) {
      bus.emit({
        type: "tool_result",
        callId: `${i}`,
        name: "read",
        output: `o${i}`,
        isError: false,
      });
    }
  };

  it("fires once after the threshold is reached", () => {
    const bus = new EventBus();
    const rec = new MemoryRecorder();
    rec.attach(bus);
    let fired = 0;
    rec.setAutoFlush(3, () => {
      fired++;
    });
    emitTool(bus, 2);
    expect(fired).toBe(0); // below threshold
    emitTool(bus, 1);
    expect(fired).toBe(1); // crossed at 3
    emitTool(bus, 5);
    expect(fired).toBe(1); // edge-guarded until clear()
  });

  it("re-arms after clear()", () => {
    const bus = new EventBus();
    const rec = new MemoryRecorder();
    rec.attach(bus);
    let fired = 0;
    rec.setAutoFlush(2, () => {
      fired++;
    });
    emitTool(bus, 2);
    expect(fired).toBe(1);
    rec.clear();
    emitTool(bus, 2);
    expect(fired).toBe(2);
  });

  it("threshold of 0 disables auto-flush", () => {
    const bus = new EventBus();
    const rec = new MemoryRecorder();
    rec.attach(bus);
    let fired = 0;
    rec.setAutoFlush(0, () => {
      fired++;
    });
    emitTool(bus, 50);
    expect(fired).toBe(0);
  });
});

describe("parseLearnings", () => {
  it("parses well-formed learning lines", () => {
    const out = [
      "LEARNING: bugfix | Fixed the parser | a.ts, b.ts | It dropped trailing fields",
      "LEARNING: feature | Added memory | core/memory.ts |",
    ].join("\n");
    const records = parseLearnings(out, 100);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      type: "bugfix",
      title: "Fixed the parser",
      files: ["a.ts", "b.ts"],
      body: "It dropped trailing fields",
      ts: 100,
    });
    expect(records[1]).toMatchObject({ type: "feature", title: "Added memory" });
    expect(records[1]?.body).toBeUndefined();
  });

  it("clamps unknown types to note and ignores non-learning lines", () => {
    const out = "some preamble\nLEARNING: nonsense | Just a title\ntrailing chatter";
    const records = parseLearnings(out, 1);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ type: "note", title: "Just a title" });
  });

  it("skips learning lines with no title", () => {
    expect(parseLearnings("LEARNING:  |  | |", 1)).toEqual([]);
  });
});

describe("digest", () => {
  it("returns [] for no observations without calling the summarizer", async () => {
    let called = false;
    const out = await digest([], async () => {
      called = true;
      return "LEARNING: note | x";
    });
    expect(out).toEqual([]);
    expect(called).toBe(false);
  });

  it("compresses observations via the summarizer", async () => {
    const out = await digest(
      [{ source: "tool", label: "edit", text: "changed config" }],
      async (prompt) => {
        expect(prompt).toContain("changed config");
        return "LEARNING: feature | Config updated | config.ts |";
      },
      42,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ type: "feature", title: "Config updated", ts: 42 });
  });

  it("treats NONE as no learnings", async () => {
    const out = await digest([{ source: "tool", label: "ls", text: "noise" }], async () => "NONE");
    expect(out).toEqual([]);
  });

  it("never throws when the summarizer fails", async () => {
    const out = await digest([{ source: "tool", label: "x", text: "y" }], async () => {
      throw new Error("model down");
    });
    expect(out).toEqual([]);
  });
});

describe("buildDigestPrompt / formatMemorySection", () => {
  it("embeds the activity log", () => {
    const prompt = buildDigestPrompt([{ source: "tool", label: "read", text: "hello" }]);
    expect(prompt).toContain("(tool:read) hello");
    expect(prompt).toContain("LEARNING:");
  });

  it("formats records into a bulleted memory block", () => {
    const records: MemoryRecord[] = [
      { id: "1", kind: "learning", ts: 1, type: "bugfix", title: "Fixed X", files: ["a.ts"] },
    ];
    const section = formatMemorySection(records);
    expect(section).toContain("- [bugfix] Fixed X (a.ts)");
    expect(formatMemorySection([])).toBe("");
  });
});
