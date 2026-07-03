import type { AutonomyMode, DiffRow, Message, TokenUsage, ToolCall } from "./types.js";

/** Lifecycle + observability events emitted by the agent loop. */
export type AgentEvent =
  | { type: "turn_start" }
  | { type: "text_delta"; delta: string }
  | { type: "assistant_message"; message: Message }
  | { type: "tool_call"; call: ToolCall }
  | {
      type: "tool_result";
      callId: string;
      name: string;
      output: string;
      isError: boolean;
      /** Rich per-line diff for file-mutating tools (rendered in the transcript). */
      diff?: DiffRow[];
      /** Path the mutating tool changed (feeds the "changed files" turn summary). */
      path?: string;
    }
  | { type: "tool_denied"; callId: string; name: string; reason?: string }
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
  | { type: "autonomy_stopped"; reason: string }
  // Sub-agent (fleet) lifecycle.
  | { type: "subagent_start"; task: string; role?: string }
  | { type: "subagent_done"; output: string }
  | { type: "fleet_start"; count: number }
  | { type: "fleet_done"; count: number }
  | { type: "fleet_worktree"; path: string; branch: string }
  // Parallel-autonomy rounds (leader decomposes → fleet → aggregate).
  | { type: "autonomy_fleet_round"; round: number; tasks: { task: string; role?: string }[] }
  | { type: "autonomy_aggregate"; round: number; count: number }
  // Phased coordinator (goal → ordered phases with handoff).
  | {
      type: "phase_plan";
      phases: { id: string; title: string; description: string; done: string }[];
    }
  | { type: "phase_start"; id: string; index: number; total: number; title: string }
  | { type: "phase_done"; id: string; index: number; title: string; summary: string }
  // Spec-Driven Development (/sdd): interview → spec → task-DAG.
  | { type: "sdd_interview"; questions: string[] }
  | { type: "sdd_spec"; id: string; specPath: string; taskCount: number }
  | {
      type: "sdd_graph";
      tasks: { id: string; title: string; dependsOn: string[]; state: SddTaskState }[];
    }
  | { type: "sdd_task_state"; id: string; title: string; state: SddTaskState }
  | { type: "sdd_done"; id: string; done: number; failed: number };

/** Lifecycle state of a single /sdd task. */
export type SddTaskState = "pending" | "running" | "done" | "failed";

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
