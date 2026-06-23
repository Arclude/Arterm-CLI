import type { ArtermConfig } from "./config.js";
import { NoneStrategy, WindowStrategy } from "./contextStrategies.js";
import type { ContextStrategy } from "./contextStrategy.js";

/** Build the context-compaction strategy selected by config. */
export function createContextStrategy(config: ArtermConfig): ContextStrategy {
  const ctx = config.context ?? { strategy: "window" };
  switch (ctx.strategy ?? "window") {
    case "none":
      return new NoneStrategy();
    case "window": {
      // Compaction triggers near the window limit, so the post-compaction target
      // must sit comfortably below it (≈60%) to actually free up room.
      const window = ctx.window ?? 8192;
      return new WindowStrategy({
        maxMessages: ctx.maxMessages ?? 40,
        maxTokens: Math.floor(window * 0.6),
      });
    }
    case "summary":
      throw new Error("context strategy 'summary' is not implemented yet");
    default:
      throw new Error(`Unknown context strategy: ${ctx.strategy}`);
  }
}
