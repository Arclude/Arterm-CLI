import type { Message } from "./types.js";

/**
 * Pluggable conversation-context compaction. A strategy decides how to shrink the
 * working message history that gets sent to the model each turn, so token usage
 * stays under the model's context window. Swappable via config (see
 * `contextRegistry.ts`).
 */

export interface CompactionContext {
  /** Estimated tokens currently held by the working history. */
  estimatedTokens: number;
  /** Active model name (lets summary strategies pick a summarizer). */
  model: string;
  /** Whether compaction was triggered automatically or by the user (/compact). */
  reason: "auto" | "manual";
}

export interface CompactionResult {
  /** The (possibly shrunken) message array to keep as the working history. */
  messages: Message[];
  /** Message count before compaction. */
  before: number;
  /** Message count after compaction. */
  after: number;
}

export interface ContextStrategy {
  readonly id: string;
  /**
   * Compact `messages` (which EXCLUDES the system message — the agent prepends
   * that separately). Implementations MUST preserve tool-call/tool-result
   * pairing: a retained `tool` message must keep its preceding `assistant`
   * tool-call, and vice versa. Returning the input unchanged is a valid no-op.
   */
  compact(
    messages: Message[],
    ctx: CompactionContext,
  ): CompactionResult | Promise<CompactionResult>;
}
