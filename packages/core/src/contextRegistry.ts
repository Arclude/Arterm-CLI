import type { ArtermConfig } from "./config.js";
import { NoneStrategy, SummaryStrategy, WindowStrategy } from "./contextStrategies.js";
import type { ContextStrategy } from "./contextStrategy.js";
import type { Summarizer } from "./memoryCapture.js";

/**
 * Build the context-compaction strategy selected by config.
 *
 * The `summarize` callback is what makes the `"summary"` strategy real: it is a
 * one-shot, tool-free model call (the same kind used for memory digests). When it
 * is omitted (sub-agents, tests, any caller without a provider) the `"summary"`
 * strategy degrades to `"window"` so the session still works.
 */
export function createContextStrategy(
  config: ArtermConfig,
  summarize?: Summarizer,
): ContextStrategy {
  const ctx = config.context ?? { strategy: "window" };
  const strategy = ctx.strategy ?? "window";
  if (strategy === "none") return new NoneStrategy();

  // Compaction triggers near the window limit, so the post-compaction target must
  // sit comfortably below it (≈60%) to actually free up room.
  const window = ctx.window ?? 8192;
  const opts = { maxMessages: ctx.maxMessages ?? 40, maxTokens: Math.floor(window * 0.6) };

  if (strategy === "summary") {
    if (summarize) return new SummaryStrategy({ ...opts, summarize });
    // No summarizer available — fall back to 'window' rather than crash the session,
    // since "summary" is an advertised config value.
    process.stderr.write(
      "⚠ context strategy 'summary' needs a model-backed summarizer; falling back to 'window'.\n",
    );
  } else if (strategy !== "window") {
    throw new Error(`Unknown context strategy: ${ctx.strategy}`);
  }

  return new WindowStrategy(opts);
}
