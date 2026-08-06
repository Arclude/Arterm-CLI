import type { EventBus } from "./eventBus.js";
import type { Middleware, RequestCtx, ResponseCtx, ToolCallCtx } from "./kernel/pipeline.js";
import type { TokenUsage } from "./types.js";

/**
 * OpenTelemetry GenAI semantics for the agent loop.
 *
 * Arterm already publishes everything a run does — to its own event bus and its
 * own status server. Both are ours, which is exactly the problem: an operator
 * running this next to Copilot, Codex and Claude Code gets three runs in their
 * OTLP backend and a fourth that only Arterm can read. `gen_ai.*` is the shared
 * vocabulary that fixes that, and it costs one adapter rather than a rewrite.
 *
 * This file is the MAPPING half — which of our seams becomes which span, under
 * which attribute names. The mechanism (an OTLP exporter, an SDK) lives in
 * `@arterm/cli` behind {@link TelemetrySink}, the same split the sandbox uses,
 * so `core` takes no dependency on OpenTelemetry and the loop keeps working
 * with no exporter attached.
 */

/**
 * The semconv release these attribute names are copied from.
 *
 * The GenAI conventions are still pre-stable and have already renamed things
 * under people (`gen_ai.system` → `gen_ai.provider.name`), so the version is
 * pinned and stated rather than tracked silently. Emitting a mix of two
 * vintages is worse than emitting an old one consistently: a dashboard can
 * migrate a known version, but it cannot group by an attribute that is
 * sometimes one key and sometimes another.
 */
export const GENAI_SEMCONV_VERSION = "1.43.0";

/** Pinned `gen_ai.*` attribute keys (semconv {@link GENAI_SEMCONV_VERSION}). */
export const GENAI = {
  operationName: "gen_ai.operation.name",
  providerName: "gen_ai.provider.name",
  requestModel: "gen_ai.request.model",
  responseModel: "gen_ai.response.model",
  usageInputTokens: "gen_ai.usage.input_tokens",
  usageOutputTokens: "gen_ai.usage.output_tokens",
  usageCacheRead: "gen_ai.usage.cache_read.input_tokens",
  usageCacheCreation: "gen_ai.usage.cache_creation.input_tokens",
  toolName: "gen_ai.tool.name",
  toolCallId: "gen_ai.tool.call.id",
  agentName: "gen_ai.agent.name",
  tokenType: "gen_ai.token.type",
  conversationId: "gen_ai.conversation.id",
} as const;

/** Pinned metric names (semconv {@link GENAI_SEMCONV_VERSION}). */
export const GENAI_METRICS = {
  tokenUsage: "gen_ai.client.token.usage",
  operationDuration: "gen_ai.client.operation.duration",
} as const;

/** The `gen_ai.operation.name` values this loop produces. */
export const GENAI_OPERATION = {
  chat: "chat",
  executeTool: "execute_tool",
  invokeAgent: "invoke_agent",
} as const;

export type TelemetryAttributes = Record<string, string | number | boolean>;

/** A started span. Structural on purpose — an OTel `Span` satisfies it as-is. */
export interface TelemetrySpan {
  setAttributes(attributes: TelemetryAttributes): void;
  /** Mark the span failed. Takes a message, not an Error: our events carry strings. */
  fail(message: string): void;
  end(): void;
}

/**
 * The mechanism seam. `@arterm/cli` implements it over the OTLP exporter; tests
 * implement it in ten lines; a run with telemetry off never constructs one.
 */
export interface TelemetrySink {
  startSpan(name: string, attributes: TelemetryAttributes): TelemetrySpan;
  /** `gen_ai.client.token.usage` — one record per token type, per the convention. */
  recordTokens(tokens: number, type: "input" | "output", attributes: TelemetryAttributes): void;
  /** `gen_ai.client.operation.duration`, in SECONDS (the unit the convention fixes). */
  recordDuration(seconds: number, attributes: TelemetryAttributes): void;
}

/** What the run is talking to right now, read at emit time so `/model` propagates. */
export type TelemetrySubject = () => { model: string; provider: string; agent?: string };

/**
 * Bridges the agent loop onto a {@link TelemetrySink}.
 *
 * One instance per agent. The pipeline stages hold their pending span in this
 * object, so installing the same instance on two concurrently running agents
 * would cross their spans — `stages()` is called once per agent for that reason.
 */
export class GenAiTelemetry {
  private chat: { span: TelemetrySpan; startedAt: number } | undefined;

  constructor(
    private readonly sink: TelemetrySink,
    private readonly subject: TelemetrySubject,
  ) {}

  /** Attributes every span in this run carries. */
  private base(): TelemetryAttributes {
    const { model, provider } = this.subject();
    return { [GENAI.providerName]: provider, [GENAI.requestModel]: model };
  }

  /**
   * Turn-level `invoke_agent` spans, from the bus.
   *
   * The turn is the one boundary with no pipeline around it — `turn_start` and
   * `turn_end` are the loop's own events — so this is where the bus is the
   * right source rather than a convenience. Everything narrower comes from the
   * seam that actually brackets it.
   *
   * Returns the unsubscribe function.
   */
  attach(bus: EventBus): () => void {
    let turn: { span: TelemetrySpan; startedAt: number } | undefined;
    return bus.on((event) => {
      switch (event.type) {
        case "turn_start": {
          const { agent } = this.subject();
          const name = agent ?? "arterm";
          turn = {
            span: this.sink.startSpan(`${GENAI_OPERATION.invokeAgent} ${name}`, {
              ...this.base(),
              [GENAI.operationName]: GENAI_OPERATION.invokeAgent,
              [GENAI.agentName]: name,
            }),
            startedAt: Date.now(),
          };
          break;
        }
        case "error":
          // Recorded on the turn rather than swallowed: a run that failed and a
          // run that finished must not produce the same span.
          turn?.span.fail(event.error);
          break;
        case "turn_end": {
          if (!turn) break;
          this.sink.recordDuration((Date.now() - turn.startedAt) / 1000, {
            ...this.base(),
            [GENAI.operationName]: GENAI_OPERATION.invokeAgent,
          });
          turn.span.end();
          turn = undefined;
          break;
        }
      }
    });
  }

  /**
   * The stages that bracket the model call and each tool execution.
   *
   * These are pipeline middleware rather than bus subscribers because duration
   * is the point. `gen_ai.client.operation.duration` is what an operator alerts
   * on, and deriving it from bus events would fold tool-execution time into the
   * model's — a latency graph that is wrong in the direction that hides a slow
   * provider behind a slow tool.
   */
  stages(): { request: Middleware<RequestCtx>; response: Middleware<ResponseCtx> } {
    return {
      request: async (_ctx, next) => {
        const { model } = this.subject();
        this.chat = {
          span: this.sink.startSpan(`${GENAI_OPERATION.chat} ${model}`, {
            ...this.base(),
            [GENAI.operationName]: GENAI_OPERATION.chat,
          }),
          startedAt: Date.now(),
        };
        await next();
      },
      response: async (ctx, next) => {
        const pending = this.chat;
        this.chat = undefined;
        if (pending) {
          const { model } = this.subject();
          pending.span.setAttributes({
            [GENAI.responseModel]: model,
            ...usageAttributes(ctx.usage),
          });
          this.sink.recordDuration((Date.now() - pending.startedAt) / 1000, {
            ...this.base(),
            [GENAI.operationName]: GENAI_OPERATION.chat,
          });
          this.recordTokens(ctx.usage);
          pending.span.end();
        }
        await next();
      },
    };
  }

  /** Wraps one tool execution. Register with `toolCall.before("execute", …)`. */
  toolStage(): Middleware<ToolCallCtx> {
    return async (ctx, next) => {
      const span = this.sink.startSpan(`${GENAI_OPERATION.executeTool} ${ctx.call.name}`, {
        ...this.base(),
        [GENAI.operationName]: GENAI_OPERATION.executeTool,
        [GENAI.toolName]: ctx.call.name,
        [GENAI.toolCallId]: ctx.call.id,
      });
      const startedAt = Date.now();
      try {
        await next();
        // A tool that returned an error is not an exception here — the loop
        // hands the error back to the model as a result — but it is still a
        // failed operation, and a span that says otherwise makes the one metric
        // worth watching (tool failure rate) unreadable.
        if (ctx.isError) span.fail(ctx.output ?? "tool reported an error");
      } catch (err) {
        span.fail(err instanceof Error ? err.message : String(err));
        throw err;
      } finally {
        this.sink.recordDuration((Date.now() - startedAt) / 1000, {
          ...this.base(),
          [GENAI.operationName]: GENAI_OPERATION.executeTool,
          [GENAI.toolName]: ctx.call.name,
        });
        span.end();
      }
    };
  }

  private recordTokens(usage: TokenUsage | undefined): void {
    if (!usage) return;
    const attrs = { ...this.base(), [GENAI.operationName]: GENAI_OPERATION.chat };
    // Only what the provider actually reported. A local server that counts
    // nothing must leave the histogram empty rather than contribute zeros —
    // a zero is a measurement, and averaging it in understates every run
    // beside it.
    if (usage.promptTokens !== undefined) {
      this.sink.recordTokens(usage.promptTokens, "input", attrs);
    }
    if (usage.completionTokens !== undefined) {
      this.sink.recordTokens(usage.completionTokens, "output", attrs);
    }
  }
}

/** Usage → span attributes, omitting whatever the provider did not report. */
export function usageAttributes(usage: TokenUsage | undefined): TelemetryAttributes {
  if (!usage) return {};
  return {
    ...(usage.promptTokens !== undefined ? { [GENAI.usageInputTokens]: usage.promptTokens } : {}),
    ...(usage.completionTokens !== undefined
      ? { [GENAI.usageOutputTokens]: usage.completionTokens }
      : {}),
    ...(usage.cacheReadTokens !== undefined
      ? { [GENAI.usageCacheRead]: usage.cacheReadTokens }
      : {}),
    ...(usage.cacheWriteTokens !== undefined
      ? { [GENAI.usageCacheCreation]: usage.cacheWriteTokens }
      : {}),
  };
}
