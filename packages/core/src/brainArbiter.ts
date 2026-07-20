import type { EventBus } from "./eventBus.js";
import type { Middleware, ToolCallCtx } from "./kernel/pipeline.js";
import type { ChatProvider, Tool } from "./types.js";

export interface BrainArbiterOptions {
  provider: ChatProvider;
  /** Small, fast model that plays gatekeeper (e.g. a 1-3B local model). */
  model: string;
  bus: EventBus;
  /** Resolve a call's tool so its effect category can gate whether to screen it. */
  toolFor: (name: string) => Tool | undefined;
}

const SYSTEM =
  "You are a safety gatekeeper for a coding agent. You are shown ONE tool call the " +
  "agent wants to run. Decide if it is obviously destructive or dangerous to run in " +
  "a software project (mass deletion, disk wipe, exfiltrating secrets, fork bombs, " +
  "rewriting git history on a shared branch, disabling security). Normal development " +
  "actions — editing files, running builds/tests, installing deps, git commit — are " +
  "SAFE. When unsure, answer SAFE. Reply with exactly one word: SAFE or BLOCK.";

/**
 * A `toolCall` middleware that screens execute-category calls with a cheap model
 * BEFORE the permission chain — the OpenAI Agents SDK "cheap model guards the
 * expensive one" pattern. It can only BLOCK (short-circuit, no `next()`); it
 * never approves, so the regex `RiskArbiter` and the permission mode still run
 * after it on anything it passes. Blocking (not parallel) so a dangerous call is
 * stopped before it runs, and fail-open: any model/parse error passes the call
 * through rather than freezing the agent.
 */
export function createBrainArbiterStage(opts: BrainArbiterOptions): Middleware<ToolCallCtx> {
  return async (ctx, next) => {
    const tool = opts.toolFor(ctx.call.name);
    // Only screen side-effecting calls; reads/edits flow straight to permission.
    if (!tool || (tool.category ?? "execute") !== "execute") {
      await next();
      return;
    }
    let verdict = "SAFE";
    try {
      const prompt = `Tool: ${ctx.call.name}\nArguments: ${JSON.stringify(
        ctx.call.arguments ?? {},
      )}\n\nIs this SAFE to run or should it be BLOCKED?`;
      let text = "";
      for await (const chunk of opts.provider.chat({
        model: opts.model,
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: prompt },
        ],
        temperature: 0,
        signal: ctx.signal,
      })) {
        if (chunk.type === "text") text += chunk.delta;
      }
      verdict = text.trim().toUpperCase();
    } catch {
      // Gatekeeper unavailable — fail open, let the normal permission chain decide.
      await next();
      return;
    }
    if (verdict.startsWith("BLOCK")) {
      const reason = "Blocked by the safety gatekeeper as potentially destructive.";
      opts.bus.emit({ type: "tool_denied", callId: ctx.call.id, name: ctx.call.name, reason });
      ctx.output = reason;
      ctx.isError = true;
      return; // short-circuit: no next(), the call never reaches permission/execute
    }
    await next();
  };
}
