import type { ProviderErrorKind } from "./providerError.js";
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
  // Stale tool outputs were replaced with placeholders (cheaper than compaction).
  | { type: "tool_results_cleared"; cleared: number }
  // The turn hit a hard cap (iteration count or token budget) and stopped early —
  // surfaced so limit stops are never silent (the reply may be mid-thought).
  | { type: "run_limit"; kind: "iterations" | "tokens"; limit: number; used: number }
  | { type: "turn_end" }
  // A turn failed. When the failure came from a provider it carries the taxonomy
  // (see ProviderError), so a UI can say "out of quota" instead of pasting a
  // status line, and an operator can tell a dead key from a dropped socket.
  | {
      type: "error";
      error: string;
      kind?: ProviderErrorKind;
      provider?: string;
      status?: number;
      /** True when the same request could plausibly succeed on a retry. */
      retryable?: boolean;
    }
  // The active model refused (quota, overload, outage) and the chain moved to the
  // next configured target. Emitted before the replacement request goes out, so a
  // UI can show which model actually answered.
  | {
      type: "provider_fallback";
      from: { provider: string; model: string };
      to: { provider: string; model: string };
      reason: ProviderErrorKind;
      detail: string;
    }
  // Autonomy engine lifecycle.
  | { type: "goal_set"; goal: string; mode: AutonomyMode }
  | { type: "autonomy_step"; step: number }
  | { type: "autonomy_reflect"; done: boolean; note?: string }
  // Fresh-context verifier's judgment on a completion claim (decision 3).
  | { type: "autonomy_verify"; pass: boolean; note?: string }
  | { type: "autonomy_steer"; note: string }
  | { type: "autonomy_paused" }
  | { type: "autonomy_resumed" }
  | { type: "autonomy_done"; summary: string }
  | { type: "autonomy_stopped"; reason: string }
  // A resumed session left an unfinished autonomy checkpoint on disk — surfaced
  // so the user can decide whether to relaunch the goal (never auto-restarted).
  | {
      type: "autonomy_resume_available";
      goal: string;
      mode: AutonomyMode;
      step: number;
      savedAt?: number;
    }
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
  // Agent-team mode (/team): leader assembles a member roster, assigns work per round.
  | {
      type: "team_plan";
      members: { id: string; name: string; description: string; adhoc: boolean }[];
    }
  | { type: "team_round"; round: number; tasks: { member: string; task: string }[] }
  | {
      type: "team_member_state";
      id: string;
      name: string;
      state: SddTaskState;
      task?: string;
      filesChanged?: number;
    }
  // Bridged from a member's private bus — lets the team board show live activity.
  | { type: "team_member_event"; id: string; name: string; event: AgentEvent }
  // A blackboard posting: a member's result (broadcast) or a directed teammate
  // message. Drives the topology graph's member↔member edges in the desktop UI.
  | {
      type: "team_message";
      round: number;
      from: string;
      fromName: string;
      to?: string;
      toName?: string;
      kind: "result" | "message";
      text: string;
    }
  // A private note a member left its future self (via `memo`). Drives the member's
  // self-loop / notes view in the desktop UI. Auto-captured round recaps are NOT
  // emitted — they're derivable from the `kind: "result"` team_message above.
  | {
      type: "team_memory";
      round: number;
      member: string;
      memberName: string;
      kind: "note";
      text: string;
    }
  // Result of auto-applying a member's worktree patch to the main tree.
  | {
      type: "team_patch";
      id: string;
      name: string;
      ok: boolean;
      files: number;
      detail?: string;
    }
  | { type: "team_done"; rounds: number; done: number; failed: number }
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

/** Called when a subscriber throws. Default logs only under ARTERM_DEBUG. */
type ListenerErrorHandler = (error: unknown, event: AgentEvent) => void;

function defaultListenerErrorHandler(error: unknown, event: AgentEvent): void {
  // A throwing subscriber must never break the emit loop or the agent turn. In the
  // TUI, writing to stderr would corrupt the Ink render, so stay silent unless the
  // user opted into debug output.
  if (process.env.ARTERM_DEBUG) {
    const msg = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`event listener threw on "${event.type}": ${msg}\n`);
  }
}

/** Minimal synchronous event bus. The TUI subscribes; the agent publishes. */
export class EventBus {
  private listeners = new Set<Listener>();

  constructor(
    private readonly onListenerError: ListenerErrorHandler = defaultListenerErrorHandler,
  ) {}

  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Publish to every subscriber. Each listener is isolated: one that throws is
   * reported via `onListenerError` and does NOT stop the others from running or
   * bubble out of `emit` (which the agent calls on `turn_start` and inside its own
   * error handler — an escaping throw there would become an unhandled rejection).
   */
  emit(event: AgentEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        this.onListenerError(error, event);
      }
    }
  }
}
