import type { Session } from "./types.js";

export interface SessionMetaState {
  status: "idle" | "thinking" | "tool";
  /** Name of the tool currently executing, when status is "tool". */
  activeTool?: string;
  autonomyRunning: boolean;
  /** Active autonomous goal, while one is running. */
  goal?: string;
  /** Completed turns (turn_end count) — a cheap "how much happened" signal. */
  rounds: number;
  lastActivityAt: number;
  /**
   * First line of the last assistant message — the panel's "what came of it"
   * column. The alternative was replaying each session's transcript in the
   * panel renderer, which would read history on every repaint for a string
   * that only changes when a message lands.
   */
  lastAssistantSnippet?: string;
}

/**
 * Tiny per-session activity tracker for the session panel and the status-bar
 * badge. Subscribes to the session bus at construction so background activity
 * is captured from the moment a session exists, independent of any rendering.
 */
export class SessionMeta {
  private state: SessionMetaState = {
    status: "idle",
    autonomyRunning: false,
    rounds: 0,
    lastActivityAt: Date.now(),
  };
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribe: () => void;

  constructor(session: Session) {
    this.unsubscribe = session.bus.on((event) => {
      switch (event.type) {
        case "turn_start":
          this.patch({ status: "thinking", activeTool: undefined });
          break;
        case "tool_call":
          this.patch({ status: "tool", activeTool: event.call.name });
          break;
        case "tool_result":
        case "tool_denied":
          this.patch({ status: "thinking", activeTool: undefined });
          break;
        case "assistant_message": {
          const first = event.message.content.split("\n").find((l) => l.trim().length > 0) ?? "";
          this.patch({ lastAssistantSnippet: first.trim().slice(0, 80) || undefined });
          break;
        }
        case "turn_end":
          this.patch({
            status: "idle",
            activeTool: undefined,
            rounds: this.state.rounds + 1,
          });
          break;
        case "goal_set":
          this.patch({ autonomyRunning: true, goal: event.goal });
          break;
        case "autonomy_resumed":
          this.patch({ autonomyRunning: true });
          break;
        case "autonomy_paused":
          this.patch({ autonomyRunning: false });
          break;
        case "autonomy_done":
        case "autonomy_stopped":
          this.patch({ autonomyRunning: false, goal: undefined });
          break;
        case "error":
          this.patch({ status: "idle", activeTool: undefined });
          break;
        default:
          return; // not an activity signal — don't bump lastActivityAt
      }
    });
  }

  get(): SessionMetaState {
    return this.state;
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  dispose(): void {
    this.unsubscribe();
    this.listeners.clear();
  }

  private patch(partial: Partial<SessionMetaState>): void {
    this.state = { ...this.state, ...partial, lastActivityAt: Date.now() };
    for (const cb of this.listeners) cb();
  }
}
