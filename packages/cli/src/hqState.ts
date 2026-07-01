import type { AgentEvent } from "@arterm/core";
import type { Session } from "@arterm/tui";

/**
 * Shared live-state accumulator for the HQ dashboard, used by the agent reporter
 * (`hqReporter.ts`). Subscribes ONCE to `session.bus`, stamps each event with a
 * monotonic seq + wall-clock time (events carry neither), keeps a bounded ring, and
 * derives a live snapshot mirroring the TUI's App.tsx event→state mapping.
 */

/** An `AgentEvent` stamped with a monotonic seq + wall-clock time at the sink. */
export type StampedEvent = { seq: number; ts: number } & AgentEvent;

export const RING_MAX = 500;
const STATE_THROTTLE_MS = 250;

export interface Worker {
  task: string;
  role?: string;
  state: "running" | "done";
  output?: string;
}

/** A fan-out sink: receives one JSON-encoded `{type,...}` message per push. */
export type Sink = (chunk: string) => void;

export class HqState {
  private seq = 0;
  private ring: StampedEvent[] = [];
  private inTok = 0;
  private outTok = 0;
  private ctxUsed = 0;
  private rounds = 0;
  private status: "idle" | "thinking" | "tool" = "idle";
  private activeTool: string | null = null;
  private workers: Worker[] = [];
  private fleet = { active: 0, round: 0 };
  private readonly subscribers = new Set<Sink>();
  private readonly unsubscribe: () => void;
  private stateTimer: NodeJS.Timeout | undefined;

  constructor(private readonly session: Session) {
    this.unsubscribe = session.bus.on((ev) => this.push(ev));
  }

  private push(ev: AgentEvent): void {
    switch (ev.type) {
      case "turn_start":
        this.status = "thinking";
        break;
      case "tool_call":
        this.status = "tool";
        this.activeTool = ev.call.name;
        break;
      case "tool_result":
      case "tool_denied":
        this.status = "thinking";
        this.activeTool = null;
        break;
      case "assistant_message":
        this.rounds += 1;
        break;
      case "usage":
        this.inTok += ev.usage.promptTokens ?? 0;
        this.outTok += ev.usage.completionTokens ?? 0;
        if (ev.usage.promptTokens) this.ctxUsed = ev.usage.promptTokens;
        break;
      case "context_compacted":
        this.ctxUsed = 0;
        break;
      case "turn_end":
        this.status = "idle";
        this.activeTool = null;
        break;
      case "subagent_start":
        this.workers.push({ task: ev.task, role: ev.role, state: "running" });
        break;
      case "subagent_done": {
        const w = [...this.workers].reverse().find((x) => x.state === "running");
        if (w) {
          w.state = "done";
          w.output = ev.output;
        }
        break;
      }
      case "fleet_start":
        this.fleet.active = ev.count;
        break;
      case "fleet_done":
        this.fleet.active = 0;
        break;
      case "autonomy_fleet_round":
        this.fleet.round = ev.round;
        break;
    }

    // `text_delta` is one event per streamed token — keep it OUT of the ring and off
    // the per-event push to avoid flooding slow clients.
    if (ev.type !== "text_delta") {
      const stamped = { seq: ++this.seq, ts: Date.now(), ...ev } as StampedEvent;
      this.ring.push(stamped);
      if (this.ring.length > RING_MAX) this.ring.shift();
      this.fanout(JSON.stringify({ type: "event", event: stamped }));
    }
    this.scheduleState();
  }

  /** Coalesce derived-state pushes to ~4/sec regardless of event burst rate. */
  private scheduleState(): void {
    if (this.stateTimer) return;
    this.stateTimer = setTimeout(() => {
      this.stateTimer = undefined;
      this.fanout(JSON.stringify({ type: "state", state: this.snapshot() }));
    }, STATE_THROTTLE_MS);
  }

  private fanout(chunk: string): void {
    for (const send of this.subscribers) send(chunk);
  }

  snapshot(): Record<string, unknown> {
    return {
      status: this.status,
      model: this.session.agent.model,
      provider: this.session.providerLabel,
      permissionMode: this.session.permissionMode,
      toolCount: this.session.toolCount,
      tokens: { in: this.inTok, out: this.outTok, ctx: this.ctxUsed },
      activeTool: this.activeTool,
      rounds: this.rounds,
      autonomy: this.session.autonomy.snapshot(),
      fleet: this.fleet,
      workers: this.workers,
      seq: this.seq,
    };
  }

  events(): StampedEvent[] {
    return this.ring;
  }

  addSubscriber(send: Sink): () => void {
    this.subscribers.add(send);
    return () => this.subscribers.delete(send);
  }

  /** Initial catch-up frame for a freshly connected consumer. */
  bootstrap(): string {
    return JSON.stringify({ type: "snapshot", state: this.snapshot(), events: this.ring });
  }

  dispose(): void {
    this.unsubscribe();
    if (this.stateTimer) clearTimeout(this.stateTimer);
    this.subscribers.clear();
  }
}

/** Dispatch a control action to the autonomy engine (all methods are safe off-run). */
export function control(
  session: Session,
  action: string,
  note: string,
): { ok: boolean; error?: string } {
  switch (action) {
    case "pause":
      session.autonomy.pause();
      return { ok: true };
    case "resume":
      session.autonomy.resume();
      return { ok: true };
    case "stop":
      session.autonomy.stop();
      return { ok: true };
    case "steer":
      if (!note) return { ok: false, error: "steer requires a note" };
      session.autonomy.steer(note);
      return { ok: true };
    case "goal":
      if (!note) return { ok: false, error: "goal requires text" };
      void session.autonomy.start(note); // self-guards re-entry
      return { ok: true };
    default:
      return { ok: false, error: `unknown action "${action}"` };
  }
}
