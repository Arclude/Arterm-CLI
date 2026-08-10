import type {
  AgentEvent,
  AutonomyMode,
  PendingPermission,
  PermissionAnswer,
  ProviderErrorKind,
} from "@arterm/core";
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
/** Undoable turns carried on the state frame — enough to offer, not a history. */
const CHECKPOINT_MAX = 10;

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

/**
 * The failure that ended the last turn (contract §5).
 *
 * Without this the desktop could only learn about a failure by watching the event
 * stream go by — a client that connects after the fact, or one that only polls
 * `/api/state`, saw a session sitting at `status: "idle"` and looking perfectly
 * healthy. It carries the provider taxonomy so the UI can distinguish "out of
 * quota" from "wrong API key" and offer the right button.
 */
export interface StatusError {
  message: string;
  /** Provider taxonomy, when the failure came from a provider call. */
  kind?: ProviderErrorKind;
  provider?: string;
  status?: number;
  /** True when the same request could plausibly succeed on a retry. */
  retryable?: boolean;
  /** Epoch ms when the failure was observed. */
  at: number;
}

/** The last model switch the fallback chain made (contract §5). */
export interface StatusFallback {
  from: { provider: string; model: string };
  to: { provider: string; model: string };
  reason: ProviderErrorKind;
  detail: string;
  at: number;
}

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
  tokens: { in: number; out: number; ctx: number; ctxWindow?: number };
  activeTool: string | null;
  rounds: number;
  autonomy: AutonomySnapshot;
  fleet: { active: number; round: number };
  workers: Worker[];
  team: TeamMemberStatus[];
  activeAgents: number;
  /** The primary ("main") agent as a first-class node, symmetric with team[]. */
  main: { toolUseCount: number; recentActivities: string[] };
  /**
   * The permission prompt currently blocking the agent, answerable remotely via
   * `POST /api/control {action:"permission"}` (contract §8). `null` when none is
   * up — including in modes that never prompt (yolo/plan).
   */
  pendingPermission: PendingPermission | null;
  /** Requests queued behind {@link pendingPermission} (sub-agents share one prompt). */
  pendingPermissionQueue: number;
  /**
   * The failure that ended the most recent turn, or `null` when the last turn
   * finished cleanly. Cleared when a new turn starts — it describes the session's
   * current health, not its history (the event ring keeps that).
   */
  lastError: StatusError | null;
  /**
   * The most recent model switch made by the fallback chain, or `null`. Survives
   * across turns: the chain landing on a backup model is a standing condition
   * worth showing even after the turn it rescued has ended.
   */
  lastFallback: StatusFallback | null;
  /**
   * What this run has spent, and against which ceilings.
   *
   * Reported whether or not a ceiling is configured — spend is a fact, and an
   * unattended run's cost is the number an operator checks first. `reported`
   * separates "the backend counted nothing" from "this cost nothing": most
   * local servers report no usage, and a dashboard that renders their runs as
   * free would be stating a fiction.
   */
  budget: StatusBudget;
  /**
   * The execution boundary shell commands run inside, or `null` for a host-level
   * run. `permissionMode: "yolo"` looks identical whether or not a sandbox is in
   * force, and those are very different risk states — this is the half of the
   * story the mode alone cannot tell.
   */
  sandbox: string | null;
  /** What the unattended-run guards did this session (see `StatusGuards`). */
  guards: StatusGuards;
  /**
   * Undoable turns, newest first and bounded — enough for a dashboard to offer
   * a rewind without shipping the whole history on every state frame.
   */
  checkpoints: { id: string; label: string; at: number }[];
  seq: number;
}

/** Run spend, mirroring `BudgetState` minus its internal bookkeeping. */
export interface StatusBudget {
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  /** Priced total — cache read/write counted at their own rates. */
  totalTokens: number;
  usd: number;
  limitTokens?: number;
  limitUsd?: number;
  /** True once a ceiling is reached: the run must stop. */
  breached: boolean;
  /** True when some spend had no catalog price, so `usd` is a floor. */
  unpriced: boolean;
  /** False when the backend reported no token counts at all. */
  reported: boolean;
}

/**
 * What the guards did — the difference between a run that worked and one that
 * spun and was cut off.
 *
 * Counted rather than listed: a long run repeats them per turn, and the events
 * themselves already reach the dashboard's feed. Zero is a real answer here (it
 * means "nothing got stuck"), unlike the unknown-vs-empty cases elsewhere in
 * this snapshot, so these are always present.
 */
export interface StatusGuards {
  loopSteers: number;
  loopCuts: number;
  /** Progress-gated step-cap grants. */
  extensions: number;
  /** The most recent verification verdict, or `null` if none has landed. */
  lastVerdict: { pass: boolean; scope?: string; note?: string } | null;
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
  private ctxWindow: number | undefined;
  private rounds = 0;
  private status: "idle" | "thinking" | "tool" = "idle";
  private activeTool: string | null = null;
  private workers: Worker[] = [];
  private fleet = { active: 0, round: 0 };
  private team: TeamMemberStatus[] = [];
  private mainToolUseCount = 0;
  private mainActivities: string[] = [];
  private lastError: StatusError | null = null;
  private lastFallback: StatusFallback | null = null;
  // Guard activity accumulates across the whole session, not per turn: "did
  // this run ever get stuck" is the question, and a per-turn counter answers a
  // different, less useful one.
  private loopSteers = 0;
  private loopCuts = 0;
  private extensions = 0;
  private lastVerdict: StatusGuards["lastVerdict"] = null;
  private checkpointList: StatusSnapshot["checkpoints"] = [];
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
        // A new turn supersedes the old verdict: keeping a stale failure visible
        // would leave the desktop showing "out of quota" over a healthy session.
        this.lastError = null;
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
      case "loop_detected":
        this.loopSteers += 1;
        break;
      case "loop_cut":
        this.loopCuts += 1;
        break;
      case "autonomy_extended":
        this.extensions += 1;
        break;
      // The turn-level progress gate (`budget.autoExtendTurn`) — same meaning,
      // one level down, so it lands in the same counter.
      case "turn_extended":
        this.extensions += 1;
        break;
      case "autonomy_verify":
        this.lastVerdict = {
          pass: ev.pass,
          ...(ev.scope ? { scope: ev.scope } : {}),
          ...(ev.note ? { note: ev.note } : {}),
        };
        break;
      case "usage":
        this.inTok += ev.usage.promptTokens ?? 0;
        this.outTok += ev.usage.completionTokens ?? 0;
        break;
      // The agent's own context figure, so the desktop meter matches what the
      // agent acts on — a provider that reports no usage used to leave this at
      // 0 forever while the context filled up.
      case "context_usage":
        this.ctxUsed = ev.used;
        this.ctxWindow = ev.window;
        break;
      case "context_compacted":
        this.ctxUsed = 0;
        break;
      case "turn_end":
        this.status = "idle";
        this.activeTool = null;
        // Best-effort and unawaited: the checkpoint for the turn that just ended
        // is written by now, and a dashboard offering a rewind needs a current
        // list rather than a one-turn-stale one.
        void this.refreshCheckpoints();
        break;
      case "error":
        // The agent emits `error` and then `turn_end`, so the snapshot settles on
        // idle-with-a-reason rather than idle-looking-fine.
        this.lastError = {
          message: ev.error,
          ...(ev.kind ? { kind: ev.kind } : {}),
          ...(ev.provider ? { provider: ev.provider } : {}),
          ...(ev.status !== undefined ? { status: ev.status } : {}),
          ...(ev.retryable !== undefined ? { retryable: ev.retryable } : {}),
          at: Date.now(),
        };
        break;
      case "provider_fallback":
        this.lastFallback = {
          from: ev.from,
          to: ev.to,
          reason: ev.reason,
          detail: ev.detail,
          at: Date.now(),
        };
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
      tokens: {
        in: this.inTok,
        out: this.outTok,
        ctx: this.ctxUsed,
        ...(this.ctxWindow !== undefined ? { ctxWindow: this.ctxWindow } : {}),
      },
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
      pendingPermission: this.session.permissionBroker.current(),
      pendingPermissionQueue: this.session.permissionBroker.queuedCount(),
      lastError: this.lastError,
      lastFallback: this.lastFallback,
      budget: this.budget(),
      sandbox: this.session.sandboxDescription ?? null,
      guards: {
        loopSteers: this.loopSteers,
        loopCuts: this.loopCuts,
        extensions: this.extensions,
        lastVerdict: this.lastVerdict,
      },
      checkpoints: this.checkpointList,
      seq: this.seq,
    };
  }

  /**
   * Spend for the snapshot. A session with no budget wired (tests, headless
   * stubs) reports zeros with `reported: false` — which reads as "unknown",
   * not as "free", and is the same distinction the meter itself draws.
   */
  private budget(): StatusBudget {
    const s = this.session.budgetState?.();
    return {
      inputTokens: s?.inputTokens ?? 0,
      outputTokens: s?.outputTokens ?? 0,
      cacheTokens: s?.cacheTokens ?? 0,
      totalTokens: s?.tokens ?? 0,
      usd: s?.usd ?? 0,
      ...(s?.limitTokens !== undefined ? { limitTokens: s.limitTokens } : {}),
      ...(s?.limitUsd !== undefined ? { limitUsd: s.limitUsd } : {}),
      breached: s?.breached ?? false,
      unpriced: s?.unpriced ?? false,
      reported: s?.reported ?? false,
    };
  }

  /** Refresh the undoable-turn list. Best-effort: never throws into the loop. */
  private async refreshCheckpoints(): Promise<void> {
    try {
      const all = (await this.session.checkpoints?.list()) ?? [];
      this.checkpointList = all
        .slice(0, CHECKPOINT_MAX)
        .map((c) => ({ id: c.id, label: c.label, at: c.ts }));
    } catch {
      // A store that cannot be read is not a reason to stop reporting state.
    }
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

const PERMISSION_ANSWERS: readonly PermissionAnswer[] = ["allow", "allow_always", "deny"];

/** The `POST /api/control` body, already narrowed to strings (contract §2). */
export interface ControlRequest {
  action: string;
  /** Steer text / new goal. */
  note?: string;
  /** Target AutonomyMode for `action: "mode"`. */
  mode?: string;
  /** The `pendingPermission.id` being answered, for `action: "permission"`. */
  id?: string;
  /** The answer for `action: "permission"`. */
  answer?: string;
  /** The checkpoint id to restore, for `action: "rewind"`. */
  checkpointId?: string;
}

/** What a control action reports back. `detail` carries a success note. */
export interface ControlResult {
  ok: boolean;
  error?: string;
  detail?: string;
  /**
   * `rewind`'s counts, as DATA rather than as the prose in `detail`.
   *
   * A client has to tell a clean restore from one that left files behind, and
   * making it match a word in a sentence puts a wording change on one side of
   * an IPC boundary in charge of correctness on the other. That is the same
   * rule `verify.ts` states for verdicts: the number is the contract, the
   * sentence is for a human to read.
   */
  rewind?: { restored: number; unchanged: number; skippedLinks: number };
}

/**
 * Dispatch a control action. Autonomy actions are safe off-run (all engine
 * methods no-op when idle); `permission` answers the prompt currently blocking
 * the agent and fails cleanly when there is none.
 */
export async function control(session: Session, req: ControlRequest): Promise<ControlResult> {
  const { action, note = "", mode } = req;
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
    case "rewind": {
      // Restoring files under a running agent is destructive and asynchronous,
      // which is why this is the one action that returns a promise. The caller
      // awaits; every other action stays synchronous rather than being made
      // async for symmetry it does not need.
      if (!session.checkpoints) {
        return { ok: false, error: "this session has no checkpoint store" };
      }
      const { checkpointId } = req;
      if (!checkpointId) return { ok: false, error: "rewind requires checkpointId" };
      return session.checkpoints
        .restore(checkpointId)
        .then((r) => ({
          ok: true,
          // Reported, not swallowed: a partial restore that reads as a full one
          // is the failure mode this whole feature exists to avoid. The counts
          // go out as data; `detail` is the same fact phrased for a human.
          rewind: {
            restored: r.restored,
            unchanged: r.unchanged,
            skippedLinks: r.skippedLinks,
          },
          detail: [
            `restored ${r.restored}`,
            `unchanged ${r.unchanged}`,
            ...(r.skippedLinks > 0 ? [`skipped ${r.skippedLinks} link(s)`] : []),
          ].join(", "),
        }))
        .catch((err: unknown) => ({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        }));
    }
    case "permission": {
      const { id, answer } = req;
      if (!id) return { ok: false, error: "permission requires the pending request id" };
      if (!answer || !PERMISSION_ANSWERS.includes(answer as PermissionAnswer)) {
        return { ok: false, error: `permission requires answer: ${PERMISSION_ANSWERS.join(", ")}` };
      }
      return session.permissionBroker.answer(id, answer as PermissionAnswer);
    }
    default:
      return { ok: false, error: `unknown action "${action}"` };
  }
}
