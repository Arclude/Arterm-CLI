import type { ArtermConfig } from "./config.js";
import { JsonlMemoryStore, type MemoryStore, NullMemoryStore } from "./memory.js";

/** Build the memory store selected by config, scoped to `cwd`. Defaults to "jsonl". */
export function createMemoryStore(config: ArtermConfig, cwd: string): MemoryStore {
  switch (config.memory?.mode ?? "jsonl") {
    case "off":
      return new NullMemoryStore();
    case "jsonl":
      return new JsonlMemoryStore(cwd);
    default:
      throw new Error(`Unknown memory mode: ${config.memory?.mode}`);
  }
}
