import {
  GENAI,
  GENAI_METRICS,
  GENAI_SEMCONV_VERSION,
  type TelemetryAttributes,
  type TelemetrySink,
  type TelemetrySpan,
} from "@arterm/core";

/**
 * The MECHANISM half of GenAI telemetry — see `core/src/telemetry.ts` for which
 * seam becomes which span.
 *
 * Everything OpenTelemetry lives behind this file and is imported lazily, for
 * the same reason the sandbox runtime is: starting an SDK, resolving exporters
 * and opening an OTLP connection is real startup cost, and a session with
 * telemetry off must not pay a millisecond of it.
 *
 * Failure here is never fatal. Observability that can take down the thing it
 * observes is a worse trade than no observability: an unreachable collector, a
 * missing package, or a bad endpoint degrades to "no spans" plus one line on
 * stderr, and the run continues.
 */

export interface OtelOptions {
  /** OTLP/HTTP endpoint. Falls back to the standard OTEL_* env vars. */
  endpoint?: string;
  /** `service.name` for the emitted resource. */
  serviceName?: string;
  /** Extra OTLP headers (auth tokens for hosted collectors). */
  headers?: Record<string, string>;
}

export interface OtelHandle {
  sink: TelemetrySink;
  /** Flush and shut down. Called at session end; never throws. */
  shutdown(): Promise<void>;
}

/** Either a live exporter, or the reason there isn't one. */
export type OtelAttempt = { ok: true; handle: OtelHandle } | { ok: false; reason: string };

export async function startOtel(opts: OtelOptions): Promise<OtelAttempt> {
  let api: typeof import("@opentelemetry/api");
  let traceSdk: typeof import("@opentelemetry/sdk-trace-node");
  let metricSdk: typeof import("@opentelemetry/sdk-metrics");
  let traceExporter: typeof import("@opentelemetry/exporter-trace-otlp-http");
  let metricExporter: typeof import("@opentelemetry/exporter-metrics-otlp-http");
  let resources: typeof import("@opentelemetry/resources");
  try {
    [api, traceSdk, metricSdk, traceExporter, metricExporter, resources] = await Promise.all([
      import("@opentelemetry/api"),
      import("@opentelemetry/sdk-trace-node"),
      import("@opentelemetry/sdk-metrics"),
      import("@opentelemetry/exporter-trace-otlp-http"),
      import("@opentelemetry/exporter-metrics-otlp-http"),
      import("@opentelemetry/resources"),
    ]);
  } catch (err) {
    return {
      ok: false,
      reason: `OpenTelemetry packages are not installed (${asText(err)})`,
    };
  }

  const endpoint = opts.endpoint ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) {
    return {
      ok: false,
      reason: "no OTLP endpoint (set telemetry.endpoint or OTEL_EXPORTER_OTLP_ENDPOINT)",
    };
  }

  try {
    const resource = resources.resourceFromAttributes({
      "service.name": opts.serviceName ?? "arterm",
      // Stated on every span batch, because the GenAI conventions are
      // pre-stable: a backend receiving these needs to know which vintage of
      // the attribute names it is looking at.
      "gen_ai.semconv.version": GENAI_SEMCONV_VERSION,
    });
    const headers = opts.headers ?? {};
    const provider = new traceSdk.NodeTracerProvider({
      resource,
      spanProcessors: [
        new traceSdk.BatchSpanProcessor(
          new traceExporter.OTLPTraceExporter({ url: `${trimEnd(endpoint)}/v1/traces`, headers }),
        ),
      ],
    });
    const meterProvider = new metricSdk.MeterProvider({
      resource,
      readers: [
        new metricSdk.PeriodicExportingMetricReader({
          exporter: new metricExporter.OTLPMetricExporter({
            url: `${trimEnd(endpoint)}/v1/metrics`,
            headers,
          }),
        }),
      ],
    });

    const tracer = provider.getTracer("arterm");
    const meter = meterProvider.getMeter("arterm");
    // Units are fixed by the convention, not by taste: a histogram exported as
    // milliseconds under a name the spec defines in seconds silently poisons
    // every dashboard that groups Arterm with another agent.
    const tokenHistogram = meter.createHistogram(GENAI_METRICS.tokenUsage, { unit: "{token}" });
    const durationHistogram = meter.createHistogram(GENAI_METRICS.operationDuration, { unit: "s" });

    const sink: TelemetrySink = {
      startSpan(name, attributes): TelemetrySpan {
        const span = tracer.startSpan(name, { attributes });
        return {
          setAttributes: (attrs) => span.setAttributes(attrs),
          fail: (message) => {
            span.setStatus({ code: api.SpanStatusCode.ERROR, message });
          },
          end: () => span.end(),
        };
      },
      recordTokens(tokens, type, attributes) {
        tokenHistogram.record(tokens, { ...attributes, [GENAI.tokenType]: type });
      },
      recordDuration(seconds, attributes) {
        durationHistogram.record(seconds, attributes);
      },
    };

    return {
      ok: true,
      handle: {
        sink,
        async shutdown() {
          // Both, always: a failed trace flush must not skip the metric flush,
          // and a shutdown that throws would turn "the collector went away"
          // into a non-zero exit on an otherwise successful run.
          await Promise.allSettled([provider.shutdown(), meterProvider.shutdown()]);
        },
      },
    };
  } catch (err) {
    return { ok: false, reason: `OpenTelemetry setup failed: ${asText(err)}` };
  }
}

function trimEnd(url: string): string {
  return url.replace(/\/+$/, "");
}

function asText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
