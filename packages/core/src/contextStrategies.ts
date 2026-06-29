import type { CompactionContext, CompactionResult, ContextStrategy } from "./contextStrategy.js";
import type { Summarizer } from "./memoryCapture.js";
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

export interface SummaryOptions extends WindowOptions {
  /** Produces the recap text for the messages being dropped. */
  summarize: Summarizer;
}

/** Render dropped messages as plain text for the summarizer prompt. */
function renderForSummary(messages: Message[]): string {
  return messages
    .map((m) => {
      if (m.role === "tool") {
        const head = m.name ? `tool(${m.name})` : "tool";
        return `${head}: ${m.content}`;
      }
      const calls = m.toolCalls?.length
        ? ` [called: ${m.toolCalls.map((c) => c.name).join(", ")}]`
        : "";
      return `${m.role}: ${m.content}${calls}`;
    })
    .join("\n");
}

const SUMMARY_PROMPT_HEAD =
  "You are compacting a coding-assistant conversation to save context space. " +
  "Summarize the exchange below into a concise but complete recap that lets the " +
  "assistant continue without the original messages. Preserve: the user's goals and " +
  "constraints, decisions made, files/commands touched, and any unresolved tasks. " +
  "Use terse bullet points. Do not add commentary or a preamble.\n\n--- CONVERSATION ---\n";

/**
 * Keeps a recent window like {@link WindowStrategy}, but instead of discarding the
 * older prefix it replaces it with a single model-generated recap message. Pairing
 * is preserved: the tail is cut at a clean boundary and the recap is injected as a
 * standalone `user` message (itself a clean boundary) ahead of it. If the
 * summarizer fails or returns nothing, it degrades to a plain window cut.
 */
export class SummaryStrategy implements ContextStrategy {
  readonly id = "summary";
  constructor(private readonly opts: SummaryOptions) {}

  async compact(messages: Message[], _ctx: CompactionContext): Promise<CompactionResult> {
    const before = messages.length;
    let desiredStart = 0;

    if (this.opts.maxMessages !== undefined && messages.length > this.opts.maxMessages) {
      desiredStart = messages.length - this.opts.maxMessages;
    }
    if (this.opts.maxTokens !== undefined) {
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

    const tail = cleanCut(messages, desiredStart);
    const older = messages.slice(0, messages.length - tail.length);
    // Nothing actually dropped (clean boundary walked back to the start) → no-op.
    if (older.length === 0) return { messages, before, after: before };

    let recap = "";
    try {
      recap = (await this.opts.summarize(SUMMARY_PROMPT_HEAD + renderForSummary(older))).trim();
    } catch {
      // Summarizer unreachable: fall back to a hard window cut (still paired & safe).
      return { messages: tail, before, after: tail.length };
    }
    if (!recap) return { messages: tail, before, after: tail.length };

    const summaryMessage: Message = {
      role: "user",
      content: `[Summary of earlier conversation]\n${recap}`,
    };
    const kept = [summaryMessage, ...tail];
    return { messages: kept, before, after: kept.length };
  }
}
