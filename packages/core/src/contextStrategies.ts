import type { CompactionContext, CompactionResult, ContextStrategy } from "./contextStrategy.js";
import { estimateMessageTokens } from "./tokenEstimate.js";
import type { Message } from "./types.js";

/**
 * A "clean boundary" is a message we can safely start a trimmed history from
 * without orphaning a tool result: a user message, or an assistant message that
 * did NOT request tools. Cutting anywhere else risks keeping a `tool` result
 * whose originating `assistant` tool-call was dropped (or vice versa).
 */
export function isCleanBoundary(message: Message): boolean {
  return message.role === "user" || (message.role === "assistant" && !message.toolCalls);
}

/**
 * Walk backwards from `desiredStart` to the nearest clean boundary and return the
 * slice from there to the end. Guarantees tool-call/tool-result pairing in the
 * returned history.
 */
export function cleanCut(messages: Message[], desiredStart: number): Message[] {
  let i = Math.max(0, Math.min(desiredStart, messages.length));
  while (i > 0 && !isCleanBoundary(messages[i] as Message)) i--;
  return messages.slice(i);
}

export interface WindowOptions {
  /** Keep at most this many of the most-recent messages. */
  maxMessages?: number;
  /** Keep the recent tail under roughly this many tokens. */
  maxTokens?: number;
}

/** Identity strategy — never compacts (current default-off behavior). */
export class NoneStrategy implements ContextStrategy {
  readonly id = "none";
  compact(messages: Message[], _ctx?: CompactionContext): CompactionResult {
    return { messages, before: messages.length, after: messages.length };
  }
}

/**
 * Keeps a recent window of the conversation, cutting older turns at a clean
 * boundary so tool-call pairs are never split. Honors both a message count and a
 * token budget (whichever trims more).
 */
export class WindowStrategy implements ContextStrategy {
  readonly id = "window";
  constructor(private readonly opts: WindowOptions = {}) {}

  compact(messages: Message[], _ctx: CompactionContext): CompactionResult {
    const before = messages.length;
    let desiredStart = 0;

    if (this.opts.maxMessages !== undefined && messages.length > this.opts.maxMessages) {
      desiredStart = messages.length - this.opts.maxMessages;
    }

    if (this.opts.maxTokens !== undefined) {
      // Accumulate from the end until the token budget is hit; that index is the
      // earliest message we can afford to keep.
      let tokens = 0;
      let tokenStart = messages.length;
      for (let i = messages.length - 1; i >= 0; i--) {
        tokens += estimateMessageTokens(messages[i] as Message);
        if (tokens > this.opts.maxTokens) break;
        tokenStart = i;
      }
      desiredStart = Math.max(desiredStart, tokenStart);
    }

    if (desiredStart <= 0) return { messages, before, after: before };
    const kept = cleanCut(messages, desiredStart);
    return { messages: kept, before, after: kept.length };
  }
}
