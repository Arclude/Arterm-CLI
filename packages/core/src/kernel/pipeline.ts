import type { DiffRow, ImageContent, Message, TokenUsage, Tool, ToolCall } from "../types.js";

/** Koa-style middleware: do work around `next()`, which runs the rest of the chain. */
export type Middleware<Ctx> = (ctx: Ctx, next: () => Promise<void>) => Promise<void>;

interface Entry<Ctx> {
  name: string;
  mw: Middleware<Ctx>;
}

/**
 * A named, ordered middleware chain. Stages are addressable by name so features can
 * insert (`before`), swap (`replace`) or drop (`remove`) behavior without rewriting
 * the host. `run` composes them onion-style around a shared mutable context.
 */
export class Pipeline<Ctx> {
  private entries: Entry<Ctx>[] = [];

  use(name: string, mw: Middleware<Ctx>): this {
    this.entries.push({ name, mw });
    return this;
  }

  before(name: string, mw: Middleware<Ctx>): this {
    const i = this.entries.findIndex((e) => e.name === name);
    const entry = { name: `before:${name}`, mw };
    if (i < 0) this.entries.push(entry);
    else this.entries.splice(i, 0, entry);
    return this;
  }

  replace(name: string, mw: Middleware<Ctx>): this {
    const i = this.entries.findIndex((e) => e.name === name);
    if (i < 0) this.entries.push({ name, mw });
    else this.entries[i] = { name, mw };
    return this;
  }

  remove(name: string): this {
    this.entries = this.entries.filter((e) => e.name !== name);
    return this;
  }

  has(name: string): boolean {
    return this.entries.some((e) => e.name === name);
  }

  /** Run the chain over `ctx`, returning it. A stage that omits `next()` short-circuits. */
  async run(ctx: Ctx): Promise<Ctx> {
    let lastCalled = -1;
    const dispatch = async (idx: number): Promise<void> => {
      if (idx <= lastCalled) throw new Error("pipeline next() called multiple times");
      lastCalled = idx;
      const entry = this.entries[idx];
      if (!entry) return;
      await entry.mw(ctx, () => dispatch(idx + 1));
    };
    await dispatch(0);
    return ctx;
  }
}

// Per-stage contexts mirror what the agent loop already passes around. In the early
// phases the pipelines are empty pass-throughs; the agent consumes them stage-by-stage later.
export interface UserInputCtx {
  input: string;
  /**
   * Images the user attached to this turn — a dragged path, a pasted
   * clipboard. Tool results carry their own images through `toolCall`; this is
   * the other direction, and it exists only on the turn the user attached them.
   */
  images?: ImageContent[];
}
export interface RequestCtx {
  system: Message;
  messages: Message[];
  native: boolean;
  /**
   * Set by a stage that refuses to let this request be sent (the run budget's
   * hard ceiling), carrying the reason. Short-circuiting the chain alone is not
   * enough — that only skips the remaining stages — so the loop reads this and
   * ends the turn, the same contract `toolCall.permission` uses when it denies.
   */
  refused?: string;
}
export interface ResponseCtx {
  text: string;
  calls: ToolCall[];
  /**
   * What the provider said this response cost. Present only when the backend
   * reports usage — local servers often don't — so a stage that meters spend
   * must treat `undefined` as "unknown", never as zero.
   */
  usage?: TokenUsage;
}
export interface AssistantOutputCtx {
  message: Message;
}
export interface ToolCallCtx {
  call: ToolCall;
  /** Cancellation signal handed to the tool's execute(). */
  signal?: AbortSignal;
  /** The resolved tool, set by the permission stage; absent when the name is unknown. */
  tool?: Tool;
  output?: string;
  isError?: boolean;
  /** Rich per-line diff produced by a file-mutating tool (edit/write/multi_edit). */
  diff?: DiffRow[];
  /** Path of the file a mutating tool changed. */
  path?: string;
  /**
   * Images the tool produced, after the `execute` stage has validated and
   * capped them. On the ctx rather than smuggled past it for the same reason
   * `diff` and `path` are: a stage that wants to inspect or drop what a tool is
   * about to show the model has to be able to see it.
   */
  images?: ImageContent[];
}
export interface ContextWindowCtx {
  messages: Message[];
  reason: "auto" | "manual";
  before?: number;
  after?: number;
}

export interface PipelineRegistry {
  userInput: Pipeline<UserInputCtx>;
  request: Pipeline<RequestCtx>;
  response: Pipeline<ResponseCtx>;
  assistantOutput: Pipeline<AssistantOutputCtx>;
  toolCall: Pipeline<ToolCallCtx>;
  contextWindow: Pipeline<ContextWindowCtx>;
}

export const PIPELINE_NAMES = [
  "userInput",
  "request",
  "response",
  "assistantOutput",
  "toolCall",
  "contextWindow",
] as const;

/** Build the default registry — six empty pass-through pipelines. */
export function createPipelines(): PipelineRegistry {
  return {
    userInput: new Pipeline<UserInputCtx>(),
    request: new Pipeline<RequestCtx>(),
    response: new Pipeline<ResponseCtx>(),
    assistantOutput: new Pipeline<AssistantOutputCtx>(),
    toolCall: new Pipeline<ToolCallCtx>(),
    contextWindow: new Pipeline<ContextWindowCtx>(),
  };
}
