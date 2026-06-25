import type { ArtermConfig } from "./config.js";
import { NoneStrategy, WindowStrategy } from "./contextStrategies.js";
import type { ContextStrategy } from "./contextStrategy.js";

/** Build the context-compaction strategy selected by config. */
export function createContextStrategy(config: ArtermConfig): ContextStrategy {
  const ctx = config.context ?? { strategy: "window" };
  const strategy = ctx.strategy ?? "window";
  if (strategy === "none") return new NoneStrategy();
  if (strategy === "summary") {
    // Not implemented yet — fall back to 'window' rather than crash the session at
    // startup, since "summary" is an advertised config value.
    process.stderr.write(
      "⚠ context strategy 'summary' is not implemented yet; falling back to 'window'.\n",
    );
  } else if (strategy !== "window") {
    throw new Error(`Unknown context strategy: ${ctx.strategy}`);
  }
  // Compaction triggers near the window limit, so the post-compaction target must
  // sit comfortably below it (≈60%) to actually free up room.
  const window = ctx.window ?? 8192;
  return new WindowStrategy({
    maxMessages: ctx.maxMessages ?? 40,
    maxTokens: Math.floor(window * 0.6),
  });
}
