import type { AutonomyMode, Message, TokenUsage, ToolCall } from "./types.js";

/** Lifecycle + observability events emitted by the agent loop. */
export type AgentEvent =
  | { type: "turn_start" }
  | { type: "text_delta"; delta: string }
  | { type: "assistant_message"; message: Message }
  | { type: "tool_call"; call: ToolCall }
  | { type: "tool_result"; callId: string; name: string; output: string; isError: boolean }
  | { type: "tool_denied"; callId: string; name: string }
  | { type: "usage"; usage: TokenUsage }
  | { type: "context_compacted"; before: number; after: number; reason: "auto" | "manual" }
  | { type: "turn_end" }
  | { type: "error"; error: string }
  // Autonomy engine lifecycle.
  | { type: "goal_set"; goal: string; mode: AutonomyMode }
  | { type: "autonomy_step"; step: number }
  | { type: "autonomy_reflect"; done: boolean; note?: string }
  | { type: "autonomy_steer"; note: string }
  | { type: "autonomy_paused" }
  | { type: "autonomy_resumed" }
  | { type: "autonomy_done"; summary: string }
  | { type: "autonomy_stopped"; reason: string };

type Listener = (event: AgentEvent) => void;

/** Minimal synchronous event bus. The TUI subscribes; the agent publishes. */
export class EventBus {
  private listeners = new Set<Listener>();

  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: AgentEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}
