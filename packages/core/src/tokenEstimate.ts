import type { Message } from "./types.js";

/**
 * Rough token estimation without a tokenizer dependency. Uses the common
 * ~4-characters-per-token heuristic. This is only ever used to decide whether to
 * compact the context, never for billing, so approximate is fine.
 */

/** Estimate the token count of a plain string. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Estimate one message's tokens, including any tool-call payload + framing. */
export function estimateMessageTokens(message: Message): number {
  let chars = message.content.length;
  if (message.toolCalls) {
    for (const call of message.toolCalls) {
      chars += call.name.length + JSON.stringify(call.arguments).length;
    }
  }
  if (message.name) chars += message.name.length;
  // +4 per message for role/structural framing overhead.
  return Math.ceil(chars / 4) + 4;
}

/** Estimate the total tokens of a message array. */
export function estimateHistoryTokens(messages: Message[]): number {
  let total = 0;
  for (const message of messages) total += estimateMessageTokens(message);
  return total;
}
