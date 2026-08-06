import { describe, expect, it } from "vitest";
import { EventBus } from "./eventBus.js";
import type { RequestCtx, ResponseCtx, ToolCallCtx } from "./kernel/pipeline.js";
import {
  GENAI,
  GENAI_METRICS,
  GENAI_OPERATION,
  GENAI_SEMCONV_VERSION,
  GenAiTelemetry,
  type TelemetryAttributes,
  type TelemetrySink,
  usageAttributes,
} from "./telemetry.js";

interface RecordedSpan {
  name: string;
  attributes: TelemetryAttributes;
  failed?: string;
  ended: boolean;
}

function fakeSink() {
  const spans: RecordedSpan[] = [];
  const tokens: { tokens: number; type: string; attributes: TelemetryAttributes }[] = [];
  const durations: { seconds: number; attributes: TelemetryAttributes }[] = [];
  const sink: TelemetrySink = {
    startSpan(name, attributes) {
      const span: RecordedSpan = { name, attributes: { ...attributes }, ended: false };
      spans.push(span);
      return {
        setAttributes: (attrs) => Object.assign(span.attributes, attrs),
        fail: (message) => {
          span.failed = message;
        },
        end: () => {
          span.ended = true;
        },
      };
    },
    recordTokens: (t, type, attributes) => tokens.push({ tokens: t, type, attributes }),
    recordDuration: (seconds, attributes) => durations.push({ seconds, attributes }),
  };
  return { sink, spans, tokens, durations };
}

const subject = () => ({ model: "qwen2.5:7b", provider: "ollama", agent: "arterm" });
const run = async (mw: (ctx: never, next: () => Promise<void>) => Promise<void>, ctx: unknown) =>
  mw(ctx as never, async () => {});

describe("GenAiTelemetry — chat spans", () => {
  it("emits a chat span named by the convention, with the pinned attribute keys", async () => {
    const { sink, spans, tokens, durations } = fakeSink();
    const t = new GenAiTelemetry(sink, subject);
    const stages = t.stages();

    await run(stages.request, {} as RequestCtx);
    await run(stages.response, {
      text: "hi",
      calls: [],
      usage: { promptTokens: 120, completionTokens: 30, cacheReadTokens: 900 },
    } as ResponseCtx);

    expect(spans).toHaveLength(1);
    // `{operation} {model}` is the span-name format the convention fixes; a
    // backend groups on it, so it is asserted verbatim rather than loosely.
    expect(spans[0]?.name).toBe("chat qwen2.5:7b");
    expect(spans[0]?.attributes).toMatchObject({
      [GENAI.operationName]: GENAI_OPERATION.chat,
      // The 1.43 name. `gen_ai.system` was the old key and emitting it would
      // silently split every dashboard that groups by provider.
      [GENAI.providerName]: "ollama",
      [GENAI.requestModel]: "qwen2.5:7b",
      [GENAI.responseModel]: "qwen2.5:7b",
      [GENAI.usageInputTokens]: 120,
      [GENAI.usageOutputTokens]: 30,
      [GENAI.usageCacheRead]: 900,
    });
    expect(spans[0]?.ended).toBe(true);
    expect(tokens).toEqual([
      { tokens: 120, type: "input", attributes: expect.objectContaining({}) },
      { tokens: 30, type: "output", attributes: expect.objectContaining({}) },
    ]);
    expect(tokens[0]?.attributes[GENAI.tokenType]).toBeUndefined(); // added by the sink
    expect(durations.some((d) => d.attributes[GENAI.operationName] === GENAI_OPERATION.chat)).toBe(
      true,
    );
  });

  it("records no token measurements when the backend reported none", async () => {
    // A zero is a measurement. Contributing zeros for a local server that
    // counts nothing drags every percentile beside it toward zero, which is
    // worse than an empty histogram.
    const { sink, tokens } = fakeSink();
    const stages = new GenAiTelemetry(sink, subject).stages();
    await run(stages.request, {} as RequestCtx);
    await run(stages.response, { text: "", calls: [] } as ResponseCtx);
    expect(tokens).toEqual([]);
  });

  it("times only the provider call, not the tool work that follows it", async () => {
    const { sink, durations } = fakeSink();
    const stages = new GenAiTelemetry(sink, subject).stages();
    await run(stages.request, {} as RequestCtx);
    await new Promise((r) => setTimeout(r, 20));
    await run(stages.response, { text: "", calls: [] } as ResponseCtx);
    const chat = durations.find((d) => d.attributes[GENAI.operationName] === GENAI_OPERATION.chat);
    // The whole reason these are pipeline stages and not bus subscribers: the
    // window is exactly the request, so a slow provider cannot hide behind a
    // slow tool (or the reverse).
    expect(chat?.seconds).toBeGreaterThanOrEqual(0.015);
    expect(chat?.seconds).toBeLessThan(2);
  });
});

describe("GenAiTelemetry — tool spans", () => {
  it("wraps one execution, naming the tool and its call id", async () => {
    const { sink, spans, durations } = fakeSink();
    const stage = new GenAiTelemetry(sink, subject).toolStage();
    await run(stage, {
      call: { id: "call-7", name: "bash", arguments: {} },
    } as ToolCallCtx);

    expect(spans[0]?.name).toBe("execute_tool bash");
    expect(spans[0]?.attributes).toMatchObject({
      [GENAI.operationName]: GENAI_OPERATION.executeTool,
      [GENAI.toolName]: "bash",
      [GENAI.toolCallId]: "call-7",
    });
    expect(spans[0]?.ended).toBe(true);
    expect(durations.some((d) => d.attributes[GENAI.toolName] === "bash")).toBe(true);
  });

  it("marks a tool that returned an error as failed, though nothing threw", async () => {
    // The loop hands tool errors back to the model rather than throwing, so a
    // span that only fails on exceptions would report a 100% success rate for
    // a tool that fails every time.
    const { sink, spans } = fakeSink();
    const stage = new GenAiTelemetry(sink, subject).toolStage();
    await stage(
      { call: { id: "c1", name: "bash", arguments: {} } } as ToolCallCtx,
      async function next(this: void) {},
    );
    expect(spans[0]?.failed).toBeUndefined();

    const ctx = {
      call: { id: "c2", name: "bash", arguments: {} },
      isError: true,
      output: "exit 1",
    } as ToolCallCtx;
    await run(stage, ctx);
    expect(spans[1]?.failed).toBe("exit 1");
    expect(spans[1]?.ended).toBe(true);
  });

  it("ends the span and rethrows when execution throws", async () => {
    const { sink, spans } = fakeSink();
    const stage = new GenAiTelemetry(sink, subject).toolStage();
    await expect(
      stage({ call: { id: "c", name: "bash", arguments: {} } } as ToolCallCtx, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(spans[0]?.failed).toBe("boom");
    expect(spans[0]?.ended).toBe(true);
  });
});

describe("GenAiTelemetry — turn spans", () => {
  it("opens invoke_agent on turn_start and closes it on turn_end", () => {
    const { sink, spans, durations } = fakeSink();
    const bus = new EventBus();
    new GenAiTelemetry(sink, subject).attach(bus);

    bus.emit({ type: "turn_start" });
    bus.emit({ type: "turn_end" });

    expect(spans[0]?.name).toBe("invoke_agent arterm");
    expect(spans[0]?.attributes[GENAI.agentName]).toBe("arterm");
    expect(spans[0]?.ended).toBe(true);
    expect(
      durations.some((d) => d.attributes[GENAI.operationName] === GENAI_OPERATION.invokeAgent),
    ).toBe(true);
  });

  it("marks the turn failed when the run errored", () => {
    // A run that failed and a run that finished must not produce the same span.
    const { sink, spans } = fakeSink();
    const bus = new EventBus();
    new GenAiTelemetry(sink, subject).attach(bus);
    bus.emit({ type: "turn_start" });
    bus.emit({ type: "error", error: "provider refused" });
    bus.emit({ type: "turn_end" });
    expect(spans[0]?.failed).toBe("provider refused");
  });

  it("ignores a stray turn_end with no open turn", () => {
    const { sink, spans } = fakeSink();
    const bus = new EventBus();
    new GenAiTelemetry(sink, subject).attach(bus);
    bus.emit({ type: "turn_end" });
    expect(spans).toEqual([]);
  });
});

describe("pinned conventions", () => {
  it("states the semconv version it copied its keys from", () => {
    // The GenAI conventions are pre-stable and have renamed keys under people.
    // Pinning is only meaningful if the pin is asserted somewhere.
    expect(GENAI_SEMCONV_VERSION).toBe("1.43.0");
    expect(GENAI.providerName).toBe("gen_ai.provider.name");
    expect(GENAI_METRICS.tokenUsage).toBe("gen_ai.client.token.usage");
    expect(GENAI_METRICS.operationDuration).toBe("gen_ai.client.operation.duration");
  });

  it("omits usage attributes the provider never reported", () => {
    expect(usageAttributes(undefined)).toEqual({});
    expect(usageAttributes({ promptTokens: 5 })).toEqual({ [GENAI.usageInputTokens]: 5 });
  });
});
