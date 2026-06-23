import type { ArtermConfig } from "./config.js";
import { JsonlSessionStore, NullSessionStore } from "./sessionStore.js";
import type { RetentionPolicy, SessionStore } from "./sessionStore.js";

/** Build the session store selected by config. Defaults to "off" (no disk). */
export function createSessionStore(config: ArtermConfig): SessionStore {
  switch (config.session?.mode ?? "off") {
    case "off":
      return new NullSessionStore();
    case "jsonl":
      return new JsonlSessionStore();
    default:
      throw new Error(`Unknown session mode: ${config.session?.mode}`);
  }
}

/** Extract the retention policy from config. */
export function retentionFromConfig(config: ArtermConfig): RetentionPolicy {
  return {
    maxSessions: config.session?.maxSessions,
    maxAgeDays: config.session?.maxAgeDays,
  };
}
