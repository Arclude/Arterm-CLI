import type { AgentEvent, AutonomyMode } from "@arterm/core";
import type { Session } from "@arterm/tui";

/**
 * Live-state accumulator for the desktop status server (`statusServer.ts`), per
 * docs/desktop-integration.md. Subscribes ONCE to `session.bus`, stamps each event with a
 * monotonic seq + wall-clock time (events carry neither), keeps a bounded ring, and derives
 * a live snapshot mirroring the TUI's App.tsx event→state mapping (including the /team
 * member board).
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

/** One row of the live /team member board (contract §6). */
export interface TeamMemberStatus {
  id: string;
  name: string;
  description: string;
  adhoc: boolean;
  state: "pending" | "running" | "done" | "failed";
  task?: string;
  activity?: string;
  filesChanged?: number;
  /** Live per-member telemetry accumulated from `team_member_event` inner events. */
  toolUseCount: number;
  tokenCount: number;
  /** Rolling window of the member's last activities (newest last, capped). */
  recentActivities: string[];
  /** Epoch ms when the member first entered `running` (for elapsed time). */
  startedAt?: number;
  /** Epoch ms of the member's most recent activity (for idle detection). */
  lastActivityAt?: number;
}

/** How many recent per-member activities to retain for the drill-down feed. */
export const MEMBER_ACTIVITY_MAX = 5;

type AutonomySnapshot = ReturnType<Session["autonomy"]["snapshot"]>;

/** The full derived state pushed to the desktop (contract §5). */
export interface StatusSnapshot {
  v: 1;
  pid: number;
  sessionId: string;
  cwd: string;
  startedAt: number;
  status: "idle" | "thinking" | "tool";
  model: string;
  provider: string;
  permissionMode: string;
  toolCount: number;
  tokens: { in: number; out: number; ctx: number };
  activeTool: string | null;
  rounds: number;
  autonomy: AutonomySnapshot;
  fleet: { active: number; round: number };
  workers: Worker[];
  team: TeamMemberStatus[];
  activeAgents: number;
  /** The primary ("main") agent as a first-class node, symmetric with team[]. */
  main: { toolUseCount: number; recentActivities: string[] };
  seq: number;
}

/** A fan-out message: the transport (SSE framing) is applied by the subscriber. */
export type SinkMessage =
  | { kind: "event"; event: StampedEvent }
  | { kind: "state"; state: StatusSnapshot };

export type Sink = (msg: SinkMessage) => void;

export class StatusState {
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
  private team: TeamMemberStatus[] = [];
  private mainToolUseCount = 0;
  private mainActivities: string[] = [];
  private readonly startedAt = Date.now();
  private readonly subscribers = new Set<Sink>();
  private readonly unsubscribe: () => void;
  private stateTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly session: Session,
    private readonly meta: { sessionId: string; cwd: string },
  ) {
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
        this.mainToolUseCount += 1;
        this.pushMainActivity(`⚙ ${ev.call.name}`);
        break;
      case "tool_result":
      case "tool_denied":
        this.status = "thinking";
        this.activeTool = null;
        break;
      case "assistant_message":
        this.rounds += 1;
        this.pushMainActivity("✎ writing");
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
      case "team_plan":
        // Reset the board; every member starts pending (mirrors App.tsx).
        this.team = ev.members.map((m) => ({
          id: m.id,
          name: m.name,
          description: m.description,
          adhoc: m.adhoc,
          state: "pending" as const,
          toolUseCount: 0,
          tokenCount: 0,
          recentActivities: [],
        }));
        break;
      case "team_member_state":
        this.team = this.team.map((m) =>
          m.id === ev.id
            ? {
                ...m,
                state: ev.state,
                task: ev.task ?? m.task,
                filesChanged: ev.filesChanged ?? m.filesChanged,
                activity: ev.state === "running" ? m.activity : undefined,
                // Stamp the first running transition so consumers can show elapsed time.
                startedAt: ev.state === "running" && !m.startedAt ? Date.now() : m.startedAt,
              }
            : m,
        );
        break;
      case "team_member_event": {
        const inner = ev.event;
        const activity =
          inner.type === "tool_call"
            ? `⚙ ${inner.call.name}`
            : inner.type === "assistant_message"
              ? "✎ writing"
              : inner.type === "tool_denied"
                ? "⊘ denied"
                : undefined;
        this.team = this.team.map((m) => {
          if (m.id !== ev.id) return m;
          const next = { ...m, lastActivityAt: Date.now() };
          if (inner.type === "tool_call") next.toolUseCount = m.toolUseCount + 1;
          if (inner.type === "usage") {
            const used = (inner.usage.promptTokens ?? 0) + (inner.usage.completionTokens ?? 0);
            next.tokenCount = m.tokenCount + used;
          }
          if (activity) {
            next.activity = activity;
            next.recentActivities = [...m.recentActivities, activity].slice(-MEMBER_ACTIVITY_MAX);
          }
          return next;
        });
        break;
      }
    }

    // `text_delta` is one event per streamed token — keep it OUT of the ring and off
    // the per-event push to avoid flooding slow clients.
    if (ev.type !== "text_delta") {
      const stamped = { seq: ++this.seq, ts: Date.now(), ...ev } as StampedEvent;
      this.ring.push(stamped);
      if (this.ring.length > RING_MAX) this.ring.shift();
      this.fanout({ kind: "event", event: stamped });
    }
    this.scheduleState();
  }

  /** Append a main-agent activity string, capped like a member's (newest last). */
  private pushMainActivity(activity: string): void {
    this.mainActivities = [...this.mainActivities, activity].slice(-MEMBER_ACTIVITY_MAX);
  }

  /** Coalesce derived-state pushes to ~4/sec regardless of event burst rate. */
  private scheduleState(): void {
    if (this.stateTimer) return;
    this.stateTimer = setTimeout(() => {
      this.stateTimer = undefined;
      this.fanout({ kind: "state", state: this.snapshot() });
    }, STATE_THROTTLE_MS);
  }

  private fanout(msg: SinkMessage): void {
    for (const send of this.subscribers) send(msg);
  }

  snapshot(): StatusSnapshot {
    const autonomy = this.session.autonomy.snapshot();
    const activeAgents =
      (this.status !== "idle" || autonomy.state === "running" ? 1 : 0) +
      this.team.filter((m) => m.state === "running").length +
      this.workers.filter((w) => w.state === "running").length +
      this.fleet.active;
    return {
      v: 1,
      pid: process.pid,
      sessionId: this.meta.sessionId,
      cwd: this.meta.cwd,
      startedAt: this.startedAt,
      status: this.status,
      model: this.session.agent.model,
      provider: this.session.providerLabel,
      permissionMode: this.session.permissionMode,
      toolCount: this.session.toolCount,
      tokens: { in: this.inTok, out: this.outTok, ctx: this.ctxUsed },
      activeTool: this.activeTool,
      rounds: this.rounds,
      autonomy,
      fleet: this.fleet,
      workers: this.workers,
      team: this.team,
      activeAgents,
      main: {
        toolUseCount: this.mainToolUseCount,
        recentActivities: [...this.mainActivities],
      },
      seq: this.seq,
    };
  }

  /** Ring backlog, oldest first; `since` filters to events with `seq > since`. */
  events(since?: number): StampedEvent[] {
    return since ? this.ring.filter((e) => e.seq > since) : this.ring;
  }

  addSubscriber(send: Sink): () => void {
    this.subscribers.add(send);
    return () => this.subscribers.delete(send);
  }

  dispose(): void {
    this.unsubscribe();
    if (this.stateTimer) clearTimeout(this.stateTimer);
    this.subscribers.clear();
  }
}

const AUTONOMY_MODES: readonly AutonomyMode[] = ["once", "eternal", "parallel", "phased", "team"];

/** Dispatch a control action to the autonomy engine (all methods are safe off-run). */
export function control(
  session: Session,
  action: string,
  note: string,
  mode?: string,
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
    case "mode": {
      if (!mode || !AUTONOMY_MODES.includes(mode as AutonomyMode)) {
        return { ok: false, error: `mode requires one of: ${AUTONOMY_MODES.join(", ")}` };
      }
      const ok = session.autonomy.setMode(mode as AutonomyMode);
      return ok ? { ok: true } : { ok: false, error: "cannot change mode mid-run" };
    }
    default:
      return { ok: false, error: `unknown action "${action}"` };
  }
}
