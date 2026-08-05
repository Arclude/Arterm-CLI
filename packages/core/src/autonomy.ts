import type { Agent } from "./agent.js";
import { listAgentDefinitions } from "./agentRegistry.js";
import type { Blackboard } from "./blackboard.js";
import type { RunBudget } from "./budget.js";
import type { EventBus } from "./eventBus.js";
import type { MemberMemory } from "./memberMemory.js";
import { availableRoles } from "./subagent.js";
import {
  type TeamAssignment,
  type TeamMember,
  buildRosterPrompt,
  buildTeamDecomposePrompt,
  parseAssignments,
  parseRoster,
} from "./team.js";
import type { AutonomyMode, Tool } from "./types.js";
import type { Verifier, VerifyResult } from "./verify.js";

export type AutonomyState = "idle" | "running" | "paused" | "done" | "stopped";

/** One independent unit of parallel work the leader hands to a sub-agent. */
export interface AutonomyTask {
  task: string;
  role?: string;
  /**
   * Stable identity for this unit of work, threaded through the fleet events so
   * a UI can key a live row per task. Every task the engine dispatches carries
   * one: a team member's own id in team mode, a synthetic `r<round>-<n>` in
   * parallel/phased mode.
   */
  id?: string;
  /**
   * True only for team-mode assignments. The composition root reads this to
   * decide the member-only extras (per-member tools, worktree isolation, patch
   * auto-apply); a plain parallel subtask has an {@link id} but no membership.
   */
  member?: boolean;
  /** Ad-hoc member brief, prefixed onto the task (wins over the role preset). */
  instruction?: string;
  /** A definition-backed member's full system prompt. */
  systemPrompt?: string;
  /** Tool-name allowlist from the member's definition. */
  toolNames?: string[];
}

/** A result returned by one parallel sub-agent. */
export interface AutonomyTaskResult extends AutonomyTask {
  output: string;
  /** True when the sub-agent failed (its output holds the error message). */
  error?: boolean;
}

/** Runs a batch of tasks concurrently (sub-agent fleet) and returns ordered results. */
export type AutonomyFleetRunner = (
  tasks: AutonomyTask[],
  signal: AbortSignal,
) => Promise<AutonomyTaskResult[]>;

/** One ordered phase of a "phased" run (plan → implement → verify, etc.). */
export interface Phase {
  id: string;
  title: string;
  description: string;
  /** Done-criteria — used in the handoff and final assessment. */
  done: string;
  /** When true, the phase fans out into a sub-agent fleet; otherwise a single focused agent. */
  parallel?: boolean;
}

/** Atomic read-only view of the engine's live state (also the checkpoint payload). */
export interface AutonomySnapshot {
  state: AutonomyState;
  mode: AutonomyMode;
  goal: string;
  step: number;
  phases: { id: string; title: string; done: string; parallel?: boolean }[];
  team: { id: string; name: string; description: string; adhoc: boolean }[];
}

export interface AutonomyOptions {
  mode?: AutonomyMode;
  /** Step (or parallel-round) cap (safety bound). Default 25. */
  maxSteps?: number;
  /** Max independent subtasks per round in "parallel" mode. Default 16 (hard cap 16). */
  fanout?: number;
  /** Max sequential phases in "phased" mode. Default 8. */
  maxPhases?: number;
  /** Team mode: max members / concurrent assignments per round. Default 4. */
  teamFanout?: number;
  /** Team mode: cap on assignment rounds. Default 6. */
  teamRounds?: number;
  /** Fleet runner required by "parallel"/"phased"/"team" modes (injected so core stays decoupled). */
  runFleet?: AutonomyFleetRunner;
  /**
   * Team mode shared blackboard. When present, each round's results are posted to
   * it and each member's next-round task is prefixed with the board digest meant
   * for it (teammate results + messages addressed to it). Members write directed
   * notes via the `message` tool wired against the same instance. Omit to keep the
   * pure star topology (leader-only aggregation).
   */
  blackboard?: Blackboard;
  /**
   * Team mode per-member memory. When present, each member's round output is recapped
   * into its private memory and handed back — with any notes it left via the `memo`
   * tool wired against the same instance — as a prefix to its next-round task. Omit
   * to have members start every round with no memory of their own earlier work.
   */
  memberMemory?: MemberMemory;
  /**
   * Composite result verifier — a deterministic command gate with a fresh-context
   * judge behind it ("the agent doing the work isn't the one grading it").
   *
   * Every completion claim a mode makes passes through it. A rejection queues its
   * `mustFix` items as the next attempt's steer note, which every mode's prompt
   * builder already consumes; a verifier that cannot produce a verdict accepts the
   * claim, because verification is an extra net and never a new way to lose
   * finished work.
   */
  verify?: Verifier;
  /** Verification attempts per unit of work before giving up. Default 2. */
  verifyAttempts?: number;
  /**
   * Never give up on a rejection — keep taking steps instead of stopping once
   * `verifyAttempts` is spent. The mode's own bound still ends the run, so this
   * removes a give-up, not the ceiling.
   */
  verifyPersist?: boolean;
  /**
   * When the step/round cap is hit, grant `extendBy` more — but only if the run
   * made progress (tool calls or verification attempts) since the last grant.
   * No progress means genuinely stuck, and stuck stops with a clear reason.
   * Off by default: the hard cap stays unless the user opts into unattended runs.
   */
  autoExtend?: boolean;
  /** Steps granted per progress-gated extension (default 25). */
  extendBy?: number;
  /** Eternal mode: abort a single step after this long (default 5 min; 0 = off). */
  stepTimeoutMs?: number;
  /** Eternal mode: consecutive non-ok steps before the engine pivots (default 3). */
  failureBudget?: number;
  /**
   * Eternal mode: pause between steps (default 1s; 0 = none). A real model
   * paces the loop naturally, but a fast, erroring, or looping provider does
   * not — without this gap an eternal run can spin at hundreds of steps a
   * minute (observed live against a fake server). WrongStack's `cycleGapMs`.
   */
  cycleGapMs?: number;
  /** Eternal mode's completion policy: "never" (default) ignores claims; "claim" gates them. */
  eternalCompletion?: "never" | "claim";
  /**
   * The step cap was given EXPLICITLY (`--max-steps`): it is absolute. Bounds
   * eternal mode too, and is never auto-extended — an operator or CI harness
   * that pinned a number means that number. Config alone never sets this.
   */
  hardCap?: boolean;
  /**
   * The run's spend counter (see `budget.ts`). The engine reads it at two
   * points: a soft crossing becomes a wrap-up steer, a breach stops the run.
   * Shared with the agent, so metering happens once in the response pipeline.
   */
  budget?: RunBudget;
}

/** What one autonomous step actually did — the input to the eternal journal. */
interface StepOutcome {
  sawTool: boolean;
  doneSummary?: string;
  /** Distinct tool names the step used, in first-use order. */
  toolNames: string[];
  /** The loop detector cut the step's turn (same actions repeating). */
  loopCut: boolean;
  /** The eternal per-step timeout aborted the turn. */
  timedOut: boolean;
  /** Last provider error the step surfaced, if any. */
  providerError?: { retryable: boolean; message: string };
}

/**
 * Drives the Agent toward a goal autonomously: decide → execute → reflect → repeat.
 * Each "step" is one `agent.run()` turn (which itself does model-decide + tool-execute).
 * Completion is detected reliably via the injected `task_done` tool; `agent.assess()`
 * and an idle-streak/step cap are safety nets. Supports steer / pause / resume / stop.
 */
export class AutonomyEngine {
  private _state: AutonomyState = "idle";
  private mode: AutonomyMode;
  private maxSteps: number;
  private fanout: number;
  private maxPhases: number;
  private readonly runFleet?: AutonomyFleetRunner;
  private readonly blackboard?: Blackboard;
  private readonly memberMemory?: MemberMemory;
  private goal = "";
  private step = 0;
  private idleStreak = 0;
  private pendingSteer?: string;
  private stopped = false;
  private current?: AbortController;
  private resumeGate: Promise<void> = Promise.resolve();
  private resumeResolve?: () => void;
  /** Latest planned phases (phased mode) — surfaced read-only via `snapshot()`. */
  private _phases: Phase[] = [];
  /** Latest assembled team roster (team mode) — surfaced read-only via `snapshot()`. */
  private _team: TeamMember[] = [];
  private teamFanout: number;
  private teamRounds: number;

  constructor(
    private readonly agent: Agent,
    private readonly bus: EventBus,
    private readonly taskDone: Tool,
    opts: AutonomyOptions = {},
  ) {
    this.mode = opts.mode ?? "once";
    this.maxSteps = opts.maxSteps ?? 25;
    this.fanout = Math.min(16, Math.max(1, opts.fanout ?? 16));
    this.maxPhases = Math.min(20, Math.max(1, opts.maxPhases ?? 8));
    this.teamFanout = Math.min(16, Math.max(1, opts.teamFanout ?? 4));
    this.teamRounds = Math.min(20, Math.max(1, opts.teamRounds ?? 6));
    this.runFleet = opts.runFleet;
    this.blackboard = opts.blackboard;
    this.memberMemory = opts.memberMemory;
    this.verify = opts.verify;
    this.verifyAttempts = Math.min(5, Math.max(1, opts.verifyAttempts ?? 2));
    this.verifyPersist = opts.verifyPersist ?? false;
    this.autoExtend = opts.autoExtend ?? false;
    this.extendBy = Math.max(1, opts.extendBy ?? 25);
    this.stepTimeoutMs = Math.max(0, opts.stepTimeoutMs ?? 300_000);
    this.failureBudget = Math.max(1, opts.failureBudget ?? 3);
    this.cycleGapMs = Math.max(0, opts.cycleGapMs ?? 1_000);
    this.eternalCompletion = opts.eternalCompletion ?? "never";
    this.hardCap = opts.hardCap ?? false;
    this.budget = opts.budget;
  }

  private readonly verify?: Verifier;
  private readonly verifyAttempts: number;
  // Not readonly: `setUnattended` flips these two when a live session arms or
  // disarms autonomous mode (the TUI's Shift+Tab counterpart of `--autonomous`).
  private verifyPersist: boolean;
  private verifyFails = 0;
  private lastVerify?: VerifyResult;

  // --- unattended-run hardening (autoExtend + eternal continuation mechanics) ---
  private autoExtend: boolean;
  private readonly extendBy: number;
  private readonly stepTimeoutMs: number;
  private readonly failureBudget: number;
  private readonly cycleGapMs: number;
  private readonly eternalCompletion: "never" | "claim";
  private readonly hardCap: boolean;
  private readonly budget: RunBudget | undefined;
  /** Tool calls + verification attempts since the last cap extension. */
  private progressSinceExtend = 0;
  /** Eternal journal: the last few steps, classified — prepended to each directive. */
  private journal: { status: "ok" | "idle" | "error" | "loop" | "verify-fail"; note: string }[] =
    [];
  private consecutiveFailures = 0;
  private backoffAttempt = 0;
  /** Whether ANY step has ever succeeded — a dead provider must not loop silently. */
  private everOk = false;
  /** Full failure budgets burned with zero successful steps ever. */
  private exhaustedBudgets = 0;
  /** Consecutive steps the loop detector cut (bounded modes stop at 2). */
  private loopCutStreak = 0;

  /**
   * Flip the unattended switches on a live engine — the runtime counterpart of
   * the boot-time `--autonomous` profile, for a session that arms autonomous
   * mode mid-flight (TUI Shift+Tab). Only these two live here; yolo permissions
   * and `fleet.autoApprove` belong to the caller, and the loop detector is
   * wired at Agent construction. Takes effect from the next check: a goal
   * already past its rejection cap stays stopped, but a running one simply
   * consults the new values on its next boundary.
   */
  setUnattended(patch: { verifyPersist?: boolean; autoExtend?: boolean }): void {
    if (patch.verifyPersist !== undefined) this.verifyPersist = patch.verifyPersist;
    if (patch.autoExtend !== undefined) this.autoExtend = patch.autoExtend;
  }

  /**
   * Progress-gated cap extension. Called when `used` has reached the cap: grants
   * `extendBy` more steps only when something happened since the last grant —
   * WrongStack's "no progress ⇒ genuinely stuck ⇒ deny" rule.
   */
  private tryExtend(used: number): boolean {
    // An explicit --max-steps is absolute: never extended, progress or not.
    if (!this.autoExtend || this.stopped || this.hardCap) return false;
    if (this.progressSinceExtend === 0) return false;
    this.progressSinceExtend = 0;
    this.maxSteps = used + this.extendBy;
    this.bus.emit({
      type: "autonomy_extended",
      newLimit: this.maxSteps,
      reason: "progress since the last extension",
    });
    return true;
  }

  /** The cap-stop reason, honest about whether extension was in play. */
  private capReason(kind: "step" | "round"): string {
    const base = `reached ${kind} limit (${this.maxSteps})`;
    return this.autoExtend && !this.hardCap
      ? `${base}; no progress since the last extension`
      : base;
  }

  /**
   * Gate a completion claim through the composite verifier. True = accept.
   *
   * A rejection queues the verifier's `mustFix` items as the next attempt's steer
   * note, which every mode's prompt builder already consumes — so this one method
   * delivers repair feedback to all of them with no extra plumbing. Two outcomes
   * that are NOT rejections both return true: no verifier configured, and a
   * verifier that threw. An abort mid-verify returns false without counting an
   * attempt, so the caller's own pause/stop path runs instead.
   */
  private async gateClaim(
    claim: string,
    opts: { spec?: string; scope?: "goal" | "phase" | "round"; id?: string } = {},
  ): Promise<boolean> {
    const verify = this.verify;
    if (!verify) return true;
    // A verification attempt is progress: a run mid-repair-loop at the step cap
    // deserves the extension a tool-calling run gets.
    this.progressSinceExtend += 1;

    let res: VerifyResult;
    try {
      res = await verify({
        goal: this.goal,
        claim,
        ...(opts.spec ? { spec: opts.spec } : {}),
        ...(this.current?.signal ? { signal: this.current.signal } : {}),
      });
    } catch {
      // Emit even here. A silent catch made a crashed verifier indistinguishable
      // from a verified pass, which is the whole reason this path is visible now.
      this.bus.emit({
        type: "autonomy_verify",
        pass: true,
        skipped: true,
        note: "the verifier itself failed — accepting the claim",
        ...(opts.scope ? { scope: opts.scope } : {}),
      });
      return true;
    }
    if (this.current?.signal.aborted) return false;

    this.lastVerify = res;
    this.bus.emit({
      type: "autonomy_verify",
      pass: res.pass,
      ...(res.reason ? { note: res.reason } : {}),
      ...(res.by ? { by: res.by } : {}),
      ...(res.mustFix?.length ? { mustFix: res.mustFix } : {}),
      ...(res.skipped ? { skipped: true } : {}),
      attempt: this.verifyFails + 1,
      ...(opts.scope ? { scope: opts.scope } : {}),
      ...(opts.id ? { id: opts.id } : {}),
    });

    if (res.pass) {
      // Reset, or two unrelated rejections rounds apart would kill a long run.
      this.verifyFails = 0;
      return true;
    }
    this.verifyFails += 1;
    // Concat rather than overwrite: a pending user steer must not be dropped.
    this.pendingSteer = [this.pendingSteer, this.repairNote(res)].filter(Boolean).join("; ");
    return false;
  }

  /**
   * Whether this run should give up after the rejections it has taken.
   *
   * Every loop asks this instead of comparing counters itself, so `verifyPersist`
   * has one meaning in all five modes: the repair note is already queued, so
   * "false" simply lets the loop take another lap. The mode's own bound —
   * `maxSteps`, `maxPhases`, `teamRounds` — is what still ends the run, which is
   * why persisting cannot spin forever.
   */
  private outOfAttempts(): boolean {
    return !this.verifyPersist && this.verifyFails >= this.verifyAttempts;
  }

  /** A rejection, rewritten as instructions the worker can act on. */
  private repairNote(res: VerifyResult): string {
    const items = res.mustFix?.length
      ? `\nFix exactly these:\n${res.mustFix.map((m) => `- ${m}`).join("\n")}`
      : "";
    return `An independent reviewer rejected the result: ${res.reason ?? "criteria not met"}${items}\nAddress this concretely before declaring the work done again.`;
  }

  /**
   * What a fan-out round claims: the leader's integration text, plus a per-worker
   * ✓/✗ line. The reviewer needs to see that a slot failed — the leader's prose
   * routinely reads as if everything landed.
   */
  private roundClaim(note: string, results: AutonomyTaskResult[]): string {
    const rows = results
      .map((r) => `${r.error ? "✗" : "✓"} ${r.role ?? r.id ?? "worker"}: ${r.task.slice(0, 120)}`)
      .join("\n");
    return [note, rows].filter(Boolean).join("\n\n");
  }

  /**
   * True when the run has spent its budget — stops it, with the figure in the
   * reason so "why did this end" never needs a log dig.
   *
   * The soft threshold is handled elsewhere and deliberately differently: it
   * queues a wrap-up note into `pendingSteer`, the same channel a verifier
   * rejection uses, so all five modes inherit a graceful finish with no new
   * plumbing. Stopping is the last resort; asking the run to land is the first.
   */
  private budgetStop(): boolean {
    const budget = this.budget;
    if (!budget || !budget.breached) return false;
    this._state = "stopped";
    this.bus.emit({ type: "autonomy_stopped", reason: `run budget spent (${budget.describe()})` });
    return true;
  }

  /** The run stopped because the verifier kept rejecting. Emitted from one place. */
  private stopRejected(): void {
    this._state = "stopped";
    this.bus.emit({
      type: "autonomy_stopped",
      reason: `the reviewer rejected the result ${this.verifyFails}× — last: ${
        this.lastVerify?.reason ?? "criteria not met"
      }`,
    });
    // Checkpoint survives: a rejected-but-claimed goal is resumable.
  }

  get state(): AutonomyState {
    return this._state;
  }

  /**
   * Wire a checkpoint sink: called with a fresh snapshot after every step /
   * round / phase, and with `null` when the run reaches a deliberate end
   * (task_done or user stop) so a stale checkpoint never outlives its goal.
   * Limit-stops (step cap, idle streak) keep the checkpoint — those runs are
   * the resumable ones. Best-effort: sink failures never disturb the loop.
   */
  setCheckpointSink(sink?: (snap: AutonomySnapshot | null) => void | Promise<void>): void {
    this.checkpointSink = sink;
  }

  private checkpointSink?: (snap: AutonomySnapshot | null) => void | Promise<void>;

  private ckpt(clear = false): void {
    const sink = this.checkpointSink;
    if (!sink) return;
    try {
      void Promise.resolve(sink(clear ? null : this.snapshot())).catch(() => {});
    } catch {
      // Checkpointing must never disturb the run.
    }
  }

  /** Switch the run mode. Only allowed while idle/done/stopped (never mid-run). */
  setMode(mode: AutonomyMode): boolean {
    if (this._state === "running" || this._state === "paused") return false;
    this.mode = mode;
    return true;
  }

  getMode(): AutonomyMode {
    return this.mode;
  }

  /**
   * Atomic read-only view of the engine's live state — for external monitors
   * that can't reach the private goal/step/phase fields.
   */
  snapshot(): AutonomySnapshot {
    return {
      state: this._state,
      mode: this.mode,
      goal: this.goal,
      step: this.step,
      phases: this._phases.map((p) => ({
        id: p.id,
        title: p.title,
        done: p.done,
        ...(p.parallel ? { parallel: true } : {}),
      })),
      team: this._team.map((m) => ({
        id: m.id,
        name: m.name,
        description: m.description,
        adhoc: m.adhoc,
      })),
    };
  }

  /** Locks in a goal and runs the autonomous loop to completion (or stop). */
  async start(goal: string): Promise<void> {
    if (this._state === "running" || this._state === "paused") return;
    this.goal = goal.trim();
    this.step = 0;
    this.idleStreak = 0;
    this.verifyFails = 0;
    this.stopped = false;
    this.pendingSteer = undefined;
    this._phases = [];
    this._team = [];
    this.progressSinceExtend = 0;
    this.journal = [];
    this.consecutiveFailures = 0;
    this.backoffAttempt = 0;
    this.everOk = false;
    this.exhaustedBudgets = 0;
    this.loopCutStreak = 0;
    this._state = "running";
    this.bus.emit({ type: "goal_set", goal: this.goal, mode: this.mode });

    if (this.mode === "team") {
      try {
        await this.runTeamLoop();
      } finally {
        if (this._state === "running") this._state = "stopped";
      }
      return;
    }

    if (this.mode === "parallel") {
      try {
        await this.runParallelLoop();
      } finally {
        if (this._state === "running") this._state = "stopped";
      }
      return;
    }

    if (this.mode === "phased") {
      try {
        await this.runPhasedLoop();
      } finally {
        if (this._state === "running") this._state = "stopped";
      }
      return;
    }

    const baseTools = this.agent.tools;
    if (!baseTools.some((t) => t.name === this.taskDone.name)) {
      this.agent.setTools([...baseTools, this.taskDone]);
    }

    try {
      const eternal = this.mode === "eternal";
      const unbounded = eternal && !this.hardCap;
      while (
        !this.stopped &&
        (unbounded || this.step < this.maxSteps || this.tryExtend(this.step))
      ) {
        await this.gate();
        if (this.stopped) break;
        // The budget bounds EVERY mode, eternal included: `unbounded` above only
        // means "no step ceiling", and a run that cannot run out of steps is
        // exactly the one that must be able to run out of money. Checked at the
        // top of the step so a breached run stops before paying for another.
        // `return`, not `break`: the post-loop block emits the cap reason for
        // any exit that didn't set the private `stopped` flag, which would
        // overwrite "run budget spent" with "reached step limit" — the same
        // reason `stopRejected` and the loop-cut path return rather than break.
        if (this.budgetStop()) return;

        this.step += 1;
        this.bus.emit({ type: "autonomy_step", step: this.step });
        this.ckpt();

        const outcome = await this.runStep();
        if (this.stopped) break;
        if (this.paused()) continue; // paused mid-step; re-gate at loop top

        if (eternal) {
          // Eternal has its own reflect path: journal + failure budget + backoff
          // instead of assess/idle-streak (see eternalReflect).
          await this.eternalReflect(outcome);
          // Read through the getter: TS narrows `_state` to the "running" it saw
          // assigned in start() and cannot see eternalReflect's mutations.
          if (this.state === "done") return;
          // Breathing gap between steps: a real model paces the loop, a fast or
          // looping provider does not — without this an eternal run spins at
          // hundreds of steps a minute.
          if (this.cycleGapMs > 0 && !this.stopped) {
            await this.sleepInterruptible(this.cycleGapMs);
          }
          continue;
        }

        if (outcome.loopCut) {
          // The loop detector ended the turn: same actions repeating. One cut
          // queues a pivot steer; two in a row means steering did not land.
          this.loopCutStreak += 1;
          this.steer(
            "the last steps repeated the same actions with no progress — take a DIFFERENT approach to the goal",
          );
          if (this.loopCutStreak >= 2) {
            this._state = "stopped";
            this.bus.emit({ type: "autonomy_stopped", reason: "loop detected" });
            return;
          }
        } else {
          this.loopCutStreak = 0;
        }

        if (outcome.doneSummary !== undefined) {
          if (await this.gateClaim(outcome.doneSummary, { scope: "goal" })) {
            this.finish(outcome.doneSummary);
            return;
          }
          if (this.stopped) break;
          if (this.outOfAttempts()) return this.stopRejected();
          continue; // rejection feedback is queued as the next step's steer note
        }

        if (!outcome.sawTool) {
          // Model produced no actions — reflect on whether we're actually done.
          const verdict = await this.agent.assess(this.goal, this.current?.signal);
          this.bus.emit({ type: "autonomy_reflect", done: verdict.done, note: verdict.note });
          if (verdict.done) {
            const claim = verdict.note || "goal complete";
            if (await this.gateClaim(claim, { scope: "goal" })) {
              this.finish(claim);
              return;
            }
            if (this.stopped) break;
            if (this.outOfAttempts()) return this.stopRejected();
            continue;
          }
          this.idleStreak += 1;
          if (this.idleStreak >= 2) {
            this._state = "stopped";
            this.bus.emit({ type: "autonomy_stopped", reason: "no further actions were taken" });
            return;
          }
        } else {
          this.idleStreak = 0;
          this.bus.emit({ type: "autonomy_reflect", done: false });
        }
      }
      if (!this.stopped) {
        // Hit the step cap ("once" mode, or a CLI-bounded eternal run).
        this._state = "stopped";
        this.bus.emit({ type: "autonomy_stopped", reason: this.capReason("step") });
      }
    } finally {
      // Remove the injected task_done tool, restoring the normal tool set.
      this.agent.setTools(this.agent.tools.filter((t) => t.name !== this.taskDone.name));
      if (this._state === "running") this._state = "stopped";
    }
  }

  /** Runs one agent turn, watching the bus for tool activity + task_done. */
  private async runStep(): Promise<StepOutcome> {
    let sawTool = false;
    let doneSummary: string | undefined;
    const toolNames: string[] = [];
    let loopCut = false;
    let providerError: { retryable: boolean; message: string } | undefined;
    const off = this.bus.on((e) => {
      if (e.type === "tool_call") {
        sawTool = true;
        this.progressSinceExtend += 1;
        if (!toolNames.includes(e.call.name)) toolNames.push(e.call.name);
        if (e.call.name === this.taskDone.name) {
          doneSummary = String(e.call.arguments.summary ?? "");
        }
      } else if (e.type === "loop_cut") {
        loopCut = true;
      } else if (e.type === "budget_warning") {
        // The soft threshold rides the same channel a verifier rejection uses,
        // which is why no mode needs its own wrap-up plumbing: every prompt
        // builder already consumes pendingSteer. Says what remains, so the
        // model can size the landing rather than guess at it.
        this.pendingSteer = [
          this.pendingSteer,
          `You are near this run's budget (${e.spent}). Wrap up NOW: finish or safely
abandon the current edit, then call task_done with what was completed and what
was not. Do not start new work.`.replace(/\n/g, " "),
        ]
          .filter(Boolean)
          .join("; ");
      } else if (e.type === "error") {
        providerError = { retryable: e.retryable ?? false, message: e.error };
      }
    });
    this.current = new AbortController();
    // Eternal steps get a wall-clock bound: an unattended loop cannot afford one
    // hung provider call to become the whole night. The abort is indistinguishable
    // from a user Esc to the agent; `timedOut` tells the journal what happened.
    let timedOut = false;
    const timer =
      this.mode === "eternal" && this.stepTimeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            this.current?.abort();
          }, this.stepTimeoutMs)
        : undefined;
    try {
      await this.agent.run(this.stepPrompt(), this.current.signal);
    } finally {
      if (timer) clearTimeout(timer);
      off();
    }
    return { sawTool, doneSummary, toolNames, loopCut, timedOut, providerError };
  }

  /**
   * Eternal mode's per-step reflection: classify what happened into the journal,
   * gate an opted-in completion claim, back off on retryable provider errors, and
   * pivot once the failure budget is spent. Replaces the bounded modes'
   * assess/idle-streak pair — an eternal run reflects from its own record instead
   * of paying a model call to ask "are we done" after every quiet step.
   */
  private async eternalReflect(outcome: StepOutcome): Promise<void> {
    if (outcome.doneSummary !== undefined && this.eternalCompletion === "claim") {
      // The one path where eternal accepts an end: the claim passes the same
      // gate as every other mode. Rejection queues the repair note and loops —
      // persist is inherent, there is no attempt cap here on purpose.
      if (await this.gateClaim(outcome.doneSummary, { scope: "goal" })) {
        this.finish(outcome.doneSummary);
        return;
      }
      if (this.stopped || this.paused()) return;
      this.pushJournal("verify-fail", this.lastVerify?.reason ?? "reviewer rejected the claim");
      this.consecutiveFailures += 1;
    } else if (outcome.loopCut) {
      this.pushJournal("loop", "the loop detector cut this step — same actions repeating");
      this.consecutiveFailures += 1;
    } else if (outcome.timedOut) {
      this.pushJournal("error", `step aborted after ${Math.round(this.stepTimeoutMs / 1000)}s`);
      this.consecutiveFailures += 1;
    } else if (!outcome.sawTool && outcome.providerError) {
      this.pushJournal("error", outcome.providerError.message);
      this.consecutiveFailures += 1;
      if (outcome.providerError.retryable) await this.backoff();
    } else if (!outcome.sawTool) {
      this.pushJournal("idle", "no actions taken");
      this.consecutiveFailures += 1;
    } else {
      this.pushJournal("ok", `used ${outcome.toolNames.join(", ")}`);
      this.consecutiveFailures = 0;
      this.backoffAttempt = 0;
      this.everOk = true;
    }
    this.bus.emit({ type: "autonomy_reflect", done: false, note: this.journal.at(-1)?.note });

    if (this.consecutiveFailures >= this.failureBudget) {
      // A run that has NEVER succeeded and keeps erroring is a dead provider,
      // not a hard goal: after a second full budget, stop with the real reason
      // instead of hammering silently forever.
      if (!this.everOk && this.journal.at(-1)?.status === "error") {
        this.exhaustedBudgets += 1;
        if (this.exhaustedBudgets >= 2) {
          this.stopped = true;
          this._state = "stopped";
          this.bus.emit({
            type: "autonomy_stopped",
            reason: `no step has ever succeeded and the provider keeps failing: ${
              outcome.providerError?.message ?? "see the journal"
            }`,
          });
          return;
        }
      }
      await this.pivot();
      this.consecutiveFailures = 0;
    }
  }

  /** Append to the (capped) journal and announce the entry on the bus. */
  private pushJournal(
    status: "ok" | "idle" | "error" | "loop" | "verify-fail",
    note: string,
  ): void {
    const trimmed = note.length > 200 ? `${note.slice(0, 200)}…` : note;
    this.journal.push({ status, note: trimmed });
    if (this.journal.length > 5) this.journal.shift();
    this.bus.emit({ type: "autonomy_journal", status, note: trimmed });
  }

  /** The journal rendered for the next directive ("" outside eternal mode). */
  private journalBlock(): string {
    if (this.mode !== "eternal" || this.journal.length === 0) return "";
    const lines = this.journal.map((j) => `[${j.status}] ${j.note}`).join("\n");
    return `\n\nRecent iterations (newest last):\n${lines}`;
  }

  /**
   * Decision-source rotation, Arterm-flavored: after `failureBudget` non-ok
   * steps, ask the planner for ONE different concrete task and queue it as the
   * next step's steer note. Rotation, never a stop — and never a crash.
   */
  private async pivot(): Promise<void> {
    const probe = `You are working autonomously toward the GOAL: "${this.goal}".
The current approach has stalled ${this.failureBudget} step(s) in a row (recent record:${this.journalBlock() || " none"}).
Name ONE different concrete task that would advance the GOAL — a specific next action, not a plan. Reply in one or two sentences.`;
    try {
      const reply = (await this.agent.plan(probe, this.current?.signal)).trim();
      if (reply) this.steer(`pivot: ${reply.slice(0, 500)}`);
    } catch {
      // The pivot is best-effort; a dead planner must not kill the loop.
    }
  }

  /**
   * Exponential backoff for retryable provider errors: 2s doubling to 60s,
   * slept in ≤250ms slices so stop/pause land mid-wait instead of after it.
   */
  private async backoff(): Promise<void> {
    this.backoffAttempt += 1;
    const ms = Math.min(60_000, 2_000 * 2 ** (this.backoffAttempt - 1));
    this.bus.emit({ type: "autonomy_backoff", ms, attempt: this.backoffAttempt });
    await this.sleepInterruptible(ms);
  }

  /** Sleep `ms` in ≤250ms slices so stop/pause land mid-wait instead of after it. */
  private async sleepInterruptible(ms: number): Promise<void> {
    const until = Date.now() + ms;
    while (Date.now() < until && !this.stopped && !this.paused()) {
      await new Promise((r) => setTimeout(r, Math.min(250, Math.max(1, until - Date.now()))));
    }
  }

  /**
   * Parallel mode: each round the leader decomposes the goal into independent
   * subtasks, the fleet runs them concurrently, the leader integrates the results,
   * then reflects. Eternal-style — ends on assess-done, /stop, or the round cap.
   */
  private async runParallelLoop(): Promise<void> {
    const runFleet = this.runFleet;
    if (!runFleet) {
      this._state = "stopped";
      this.bus.emit({ type: "autonomy_stopped", reason: "parallel mode needs a fleet runner" });
      return;
    }

    let round = 0;
    while (!this.stopped && (round < this.maxSteps || this.tryExtend(round))) {
      await this.gate();
      if (this.stopped) break;

      round += 1;
      this.bus.emit({ type: "autonomy_step", step: round });
      this.current = new AbortController();

      const tasks = await this.decompose(round);
      if (this.stopped) break;
      if (this.paused()) continue;

      if (tasks.length === 0) {
        // Leader proposed no parallel work — reflect on whether we're done.
        const verdict = await this.agent.assess(this.goal, this.current.signal);
        this.bus.emit({ type: "autonomy_reflect", done: verdict.done, note: verdict.note });
        if (verdict.done) {
          const claim = verdict.note || "goal complete";
          if (await this.gateClaim(claim, { scope: "goal" })) {
            this.finish(claim);
            return;
          }
          if (this.stopped) break;
          if (this.outOfAttempts()) return this.stopRejected();
          // A rejection means more work, and "more work" in this mode is another
          // round — the repair note is already queued for the next decompose().
          continue;
        }
        this.idleStreak += 1;
        if (this.idleStreak >= 2) {
          this._state = "stopped";
          this.bus.emit({ type: "autonomy_stopped", reason: "no further parallel work proposed" });
          return;
        }
        continue;
      }
      this.idleStreak = 0;
      this.bus.emit({ type: "autonomy_fleet_round", round, tasks });
      this.ckpt();

      let results: AutonomyTaskResult[];
      try {
        results = await runFleet(tasks, this.current.signal);
      } catch (err) {
        if (this.stopped) break;
        if (this.paused()) continue;
        this.bus.emit({
          type: "autonomy_reflect",
          done: false,
          note: `fleet error: ${(err as Error).message}`,
        });
        continue;
      }
      if (this.stopped) break;
      if (this.paused()) continue;

      // A round of fleet results is this mode's unit of progress.
      this.progressSinceExtend += results.length;
      await this.aggregate(round, results);
      this.bus.emit({ type: "autonomy_aggregate", round, count: results.length });

      const verdict = await this.agent.assess(this.goal, this.current.signal);
      this.bus.emit({ type: "autonomy_reflect", done: verdict.done, note: verdict.note });
      if (verdict.done) {
        const claim = this.roundClaim(verdict.note || "goal complete", results);
        if (await this.gateClaim(claim, { scope: "round", id: `r${round}` })) {
          this.finish(verdict.note || "goal complete");
          return;
        }
        if (this.stopped) break;
        if (this.outOfAttempts()) return this.stopRejected();
      }
    }
    if (!this.stopped) {
      this._state = "stopped";
      this.bus.emit({ type: "autonomy_stopped", reason: this.capReason("round") });
    }
  }

  /**
   * Team mode: the leader assembles a roster of named specialist members once
   * (user agent definitions preferred, ad-hoc otherwise), then each round assigns
   * independent tasks to members, the fleet runs them concurrently (write-capable
   * members isolated in worktrees by the composition root), and the leader
   * integrates the results and reflects. Ends on assess-done, /stop, idle rounds,
   * or the round cap.
   */
  private async runTeamLoop(): Promise<void> {
    const runFleet = this.runFleet;
    if (!runFleet) {
      this._state = "stopped";
      this.bus.emit({ type: "autonomy_stopped", reason: "team mode needs a fleet runner" });
      return;
    }

    this.current = new AbortController();
    this.blackboard?.clear();
    this.memberMemory?.clear();
    const roster = await this.assembleTeam();
    if (this.stopped) return;
    this._team = roster;
    this.blackboard?.setRoster(roster.map((m) => ({ id: m.id, name: m.name })));
    this.bus.emit({
      type: "team_plan",
      members: roster.map((m) => ({
        id: m.id,
        name: m.name,
        description: m.description,
        adhoc: m.adhoc,
      })),
    });

    let round = 0;
    let done = 0;
    let failed = 0;
    const summary = () => this.bus.emit({ type: "team_done", rounds: round, done, failed });

    while (!this.stopped && round < this.teamRounds) {
      await this.gate();
      if (this.stopped) break;

      round += 1;
      this.step = round;
      if (this.blackboard) this.blackboard.round = round;
      if (this.memberMemory) this.memberMemory.round = round;
      this.bus.emit({ type: "autonomy_step", step: round });
      this.current = new AbortController();

      const assignments = await this.assignWork(roster, round);
      if (this.stopped) break;
      if (this.paused()) continue;

      if (assignments.length === 0) {
        // Leader proposed no work — reflect on whether the goal is done.
        const verdict = await this.agent.assess(this.goal, this.current.signal);
        this.bus.emit({ type: "autonomy_reflect", done: verdict.done, note: verdict.note });
        if (verdict.done) {
          const claim = verdict.note || "goal complete";
          if (await this.gateClaim(claim, { scope: "goal" })) {
            summary();
            this.finish(claim);
            return;
          }
          if (this.stopped) break;
          if (this.outOfAttempts()) {
            summary();
            return this.stopRejected();
          }
          continue;
        }
        this.idleStreak += 1;
        if (this.idleStreak >= 2) {
          this._state = "stopped";
          summary();
          this.bus.emit({ type: "autonomy_stopped", reason: "no further team work proposed" });
          return;
        }
        continue;
      }
      this.idleStreak = 0;

      // File-backed members carry their definition body as a full system prompt;
      // ad-hoc members get their brief as a task-instruction prefix. Two digests can
      // precede the task: the member's own memory (what it did/decided in earlier
      // rounds) comes first to re-establish its own context, then the blackboard
      // digest meant for it (teammate results + messages addressed to it).
      const tasks: AutonomyTask[] = assignments.map((a) => {
        const recall = this.memberMemory?.recall(a.member.id);
        const brief = this.blackboard?.briefFor(a.member.id);
        const task = [recall, brief, a.task].filter(Boolean).join("\n\n");
        return {
          task,
          role: a.member.name,
          id: a.member.id,
          member: true,
          instruction: a.member.adhoc ? a.member.instruction || undefined : undefined,
          systemPrompt: a.member.adhoc ? undefined : a.member.instruction,
          toolNames: a.member.toolNames,
        };
      });
      this.bus.emit({
        type: "team_round",
        round,
        tasks: assignments.map((a) => ({ member: a.member.name, task: a.task })),
      });
      this.ckpt();

      let results: AutonomyTaskResult[];
      try {
        results = await runFleet(tasks, this.current.signal);
      } catch (err) {
        if (this.stopped) break;
        if (this.paused()) continue;
        this.bus.emit({
          type: "autonomy_reflect",
          done: false,
          note: `fleet error: ${(err as Error).message}`,
        });
        continue;
      }
      if (this.stopped) break;
      if (this.paused()) continue;

      done += results.filter((r) => !r.error).length;
      failed += results.filter((r) => r.error).length;

      // Each member's result goes two places: the shared board, so teammates read it
      // next round (surfaced as a team_message event for the topology graph), and the
      // member's own memory, so it remembers what it did when it runs again. The two
      // are independently switchable. Failed slots hold an error string — not useful
      // as shared context or as a recap, so skip them.
      for (const r of results) {
        if (r.error || !r.id) continue;
        const name = r.role ?? "member";
        this.memberMemory?.recap(r.id, r.output);
        if (!this.blackboard) continue;
        this.blackboard.post({ from: r.id, fromName: name, kind: "result", text: r.output });
        this.bus.emit({
          type: "team_message",
          round,
          from: r.id,
          fromName: name,
          kind: "result",
          text: r.output.length > 600 ? `${r.output.slice(0, 600)}…` : r.output,
        });
      }

      await this.aggregate(round, results);
      this.bus.emit({ type: "autonomy_aggregate", round, count: results.length });

      const verdict = await this.agent.assess(this.goal, this.current.signal);
      this.bus.emit({ type: "autonomy_reflect", done: verdict.done, note: verdict.note });
      if (verdict.done) {
        const claim = this.roundClaim(verdict.note || "goal complete", results);
        // summary() only after acceptance: a rejected round is not a finished team run.
        if (await this.gateClaim(claim, { scope: "round", id: `r${round}` })) {
          summary();
          this.finish(verdict.note || "goal complete");
          return;
        }
        if (this.stopped) break;
        if (this.outOfAttempts()) {
          summary();
          return this.stopRejected();
        }
      }
    }
    summary();
    if (!this.stopped) {
      this._state = "stopped";
      this.bus.emit({
        type: "autonomy_stopped",
        reason: `reached round limit (${this.teamRounds})`,
      });
    }
  }

  /** Ask the leader to assemble the team (with a parse-proof fallback roster). */
  private async assembleTeam(): Promise<TeamMember[]> {
    const steer = this.pendingSteer;
    this.pendingSteer = undefined;
    const defs = listAgentDefinitions();
    const raw = await this.agent.plan(
      buildRosterPrompt(this.goal, defs, this.teamFanout, steer),
      this.current?.signal,
    );
    return parseRoster(raw, defs, this.teamFanout);
  }

  /** Ask the leader to assign the next round of work across the roster. */
  private async assignWork(roster: TeamMember[], round: number): Promise<TeamAssignment[]> {
    const steer = this.pendingSteer;
    this.pendingSteer = undefined;
    const raw = await this.agent.plan(
      buildTeamDecomposePrompt(this.goal, roster, round, steer, this.teamFanout),
      this.current?.signal,
    );
    return parseAssignments(raw, roster, this.teamFanout);
  }

  /**
   * Phased mode: the leader produces an ordered list of phases up front, then each
   * phase runs sequentially (fanning out to the fleet when marked parallel). A running
   * "handoff" summary is threaded between phases. Ends on /stop or after the last phase.
   */
  private async runPhasedLoop(): Promise<void> {
    if (!this.runFleet) {
      this._state = "stopped";
      this.bus.emit({ type: "autonomy_stopped", reason: "phased mode needs a fleet runner" });
      return;
    }

    this.current = new AbortController();
    const phases = await this.planPhases();
    this._phases = phases;
    if (this.stopped) return;
    this.bus.emit({
      type: "phase_plan",
      phases: phases.map((p) => ({
        id: p.id,
        title: p.title,
        description: p.description,
        done: p.done,
      })),
    });

    let handoff = "";
    for (let i = 0; i < phases.length; i++) {
      const phase = phases[i] as Phase;
      await this.gate();
      if (this.stopped) return;

      this.current = new AbortController();
      this.bus.emit({
        type: "phase_start",
        id: phase.id,
        index: i,
        total: phases.length,
        title: phase.title,
      });
      this.ckpt();

      // Repair attempts are scoped to this phase: a phase that needed two tries
      // must not spend the next phase's budget.
      this.verifyFails = 0;
      let summary = await this.runPhase(phase, i, phases.length, handoff);
      if (this.stopped) return;

      for (;;) {
        await this.gate();
        if (this.stopped) return;
        if (await this.gateClaim(summary, { spec: phase.done, scope: "phase", id: phase.id }))
          break;
        if (this.stopped) return;
        // Deliberately NOT `outOfAttempts()`: this loop re-runs the phase itself,
        // so it is the one place with no outer bound to fall back on — honoring
        // `verifyPersist` here would spin on a single phase forever. It already
        // does the persisting thing anyway, one level up: it carries on.
        if (this.verifyFails >= this.verifyAttempts) {
          // Out of attempts: carry the failure forward in the handoff rather than
          // killing an eight-phase plan over one phase. The final goal gate decides.
          summary = `${summary}\n\n[verification rejected this phase: ${
            this.lastVerify?.reason ?? "criteria not met"
          }]`;
          break;
        }
        // runPhase consumes pendingSteer, so the retry receives the mustFix items.
        summary = await this.runPhase(phase, i, phases.length, handoff);
        if (this.stopped) return;
      }

      handoff = summary;
      this.bus.emit({ type: "phase_done", id: phase.id, index: i, title: phase.title, summary });
    }

    const verdict = await this.agent.assess(this.goal, this.current?.signal);
    // This reflection was never emitted, and its verdict was thrown away — phased
    // mode reported success even when its own assessment said the goal was not met.
    this.bus.emit({ type: "autonomy_reflect", done: verdict.done, note: verdict.note });
    const claim = verdict.note || handoff || "all phases complete";
    if (!verdict.done) {
      this._state = "stopped";
      this.bus.emit({
        type: "autonomy_stopped",
        reason: `all phases ran but the goal is not complete: ${verdict.note || "no reason given"}`,
      });
      return; // checkpoint survives — this run is resumable
    }
    this.verifyFails = 0;
    if (!(await this.gateClaim(claim, { scope: "goal" }))) return this.stopRejected();
    this.finish(claim);
  }

  /** Ask the leader for an ordered phase plan, parsed tolerantly with a fallback. */
  private async planPhases(): Promise<Phase[]> {
    const steer = this.pendingSteer;
    this.pendingSteer = undefined;
    const steerLine = steer ? `\n\nSteering update from the user: "${steer}"` : "";
    const jsonShape = '[{"title": "...", "description": "...", "done": "..."}]';
    const prompt = `You are the DIRECTOR planning how to accomplish this GOAL:
"${this.goal}"

Break it into an ORDERED list of up to ${this.maxPhases} sequential phases (e.g. plan, implement, verify). Each phase runs after the previous one finishes.
Reply with ONLY a JSON array shaped like ${jsonShape}, where "done" states how to know that phase is complete. When a shell command can prove a phase is done, make the FIRST line of its "done" exactly \`verify: <command>\`.${steerLine}`;
    const raw = await this.agent.plan(prompt, this.current?.signal);
    return this.parsePhases(raw);
  }

  /** Tolerant parse of the director's phase plan: first JSON array, capped; non-empty fallback. */
  private parsePhases(raw: string): Phase[] {
    const fallback: Phase[] = [
      { id: "p1", title: "work", description: this.goal, done: "the goal is complete" },
    ];
    const match = raw.match(/\[[\s\S]*\]/);
    if (!match) return fallback;
    let parsed: unknown;
    try {
      parsed = JSON.parse(match[0]);
    } catch {
      return fallback;
    }
    if (!Array.isArray(parsed)) return fallback;
    const out: Phase[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const title = (item as { title?: unknown }).title;
      if (typeof title !== "string" || !title.trim()) continue;
      const description = (item as { description?: unknown }).description;
      const done = (item as { done?: unknown }).done;
      const parallel = (item as { parallel?: unknown }).parallel;
      out.push({
        id: `p${out.length + 1}`,
        title: title.trim(),
        description:
          typeof description === "string" && description.trim() ? description.trim() : title.trim(),
        done: typeof done === "string" && done.trim() ? done.trim() : title.trim(),
        parallel: parallel === true,
      });
      if (out.length >= this.maxPhases) break;
    }
    return out.length > 0 ? out : fallback;
  }

  /** Run one phase (fleet-of-1 or fanned out) and fold results into a new handoff. */
  private async runPhase(
    phase: Phase,
    index: number,
    total: number,
    handoff: string,
  ): Promise<string> {
    const runFleet = this.runFleet as AutonomyFleetRunner;
    const steer = this.pendingSteer;
    this.pendingSteer = undefined;
    const steerLine = steer ? `\n\nSteering update from the user: "${steer}"` : "";
    const carry = handoff ? `\n\nCarried forward from earlier phases:\n${handoff}` : "";
    const context = `GOAL: "${this.goal}"\nPhase ${index + 1}/${total}: ${phase.title} — ${phase.description}\nDone when: ${phase.done}${carry}${steerLine}`;

    let tasks: AutonomyTask[];
    if (phase.parallel) {
      const jsonShape = '[{"task": "...", "role": "<role>"}]';
      const prompt = `${context}\n\nBreak THIS phase into up to ${this.fanout} INDEPENDENT subtasks that can run CONCURRENTLY.\nReply with ONLY a JSON array shaped like ${jsonShape} (role optional, one of: ${availableRoles().join(" | ")}).`;
      const raw = await this.agent.plan(prompt, this.current?.signal);
      tasks = this.parseTasks(raw, `p${index + 1}`);
      if (tasks.length === 0) tasks = [{ task: context, id: `p${index + 1}-1` }];
    } else {
      // Single focused sub-agent gets the full phase context incl. the handoff.
      tasks = [{ task: context, id: `p${index + 1}-1` }];
    }

    this.bus.emit({ type: "autonomy_fleet_round", round: index + 1, tasks });
    let results: AutonomyTaskResult[];
    try {
      results = await runFleet(tasks, (this.current as AbortController).signal);
    } catch (err) {
      if (this.stopped) return handoff;
      return `${handoff}\n[phase ${phase.title} failed: ${(err as Error).message}]`;
    }
    if (this.stopped) return handoff;

    const body = results.map((r, i) => `### ${r.task}\n${r.output}`).join("\n\n");
    const prompt = `Phase "${phase.title}" (toward GOAL "${this.goal}") produced:

${body}

Summarize concisely for the next phase: what is now DONE, what REMAINS, and any artifacts/paths to carry forward. Do not call any tools.`;
    await this.agent.run(prompt, this.current?.signal);
    this.bus.emit({ type: "autonomy_aggregate", round: index + 1, count: results.length });

    // The leader's last assistant message is the handoff; fall back to raw results.
    const last = this.agent.history.at(-1);
    const summary = last && last.role === "assistant" ? last.content.trim() : "";
    return summary || body;
  }

  /** Ask the leader to split the next chunk of work into ≤fanout independent subtasks. */
  private async decompose(round: number): Promise<AutonomyTask[]> {
    const steer = this.pendingSteer;
    this.pendingSteer = undefined;
    const steerLine = steer ? `\n\nSteering update from the user: "${steer}"` : "";
    const roles = availableRoles().join(" | ");
    const jsonShape = '[{"task": "...", "role": "<role>"}]';
    const prompt = `You are the LEADER of a parallel sub-agent fleet working toward this GOAL:
"${this.goal}"

Round ${round}. Break the NEXT chunk of work into up to ${this.fanout} INDEPENDENT subtasks that can run CONCURRENTLY without depending on one another.
Reply with ONLY a JSON array shaped like ${jsonShape} (role optional, one of: ${roles}). If the GOAL is already complete or no parallel work remains, reply with exactly [].${steerLine}`;
    const raw = await this.agent.plan(prompt, this.current?.signal);
    return this.parseTasks(raw, `r${round}`);
  }

  /**
   * Tolerant parse of the leader's decomposition: first JSON array, validated +
   * capped. `idPrefix` scopes the synthetic per-task ids to the round that
   * produced them, so a board keyed on them replaces its rows each round instead
   * of merging two rounds' subtasks into one.
   */
  private parseTasks(raw: string, idPrefix: string): AutonomyTask[] {
    const match = raw.match(/\[[\s\S]*\]/);
    if (!match) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(match[0]);
    } catch {
      return [];
    }
    if (!Array.isArray(parsed)) return [];
    const valid = new Set(availableRoles());
    const out: AutonomyTask[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const task = (item as { task?: unknown }).task;
      if (typeof task !== "string" || !task.trim()) continue;
      const roleRaw = (item as { role?: unknown }).role;
      const role =
        typeof roleRaw === "string" && valid.has(roleRaw.toLowerCase())
          ? roleRaw.toLowerCase()
          : undefined;
      out.push({ task: task.trim(), role, id: `${idPrefix}-${out.length + 1}` });
      if (out.length >= this.fanout) break;
    }
    return out;
  }

  /** Feed the round's results back into the leader's history so context accumulates. */
  private async aggregate(round: number, results: AutonomyTaskResult[]): Promise<void> {
    const body = results.map((r, i) => `### Subtask ${i + 1}: ${r.task}\n${r.output}`).join("\n\n");
    const prompt = `Round ${round} of parallel work toward the GOAL "${this.goal}" produced these subtask results:

${body}

Integrate them: note concisely what is now done and what still remains. Do not call any tools.`;
    await this.agent.run(prompt, this.current?.signal);
  }

  private stepPrompt(): string {
    const steer = this.pendingSteer;
    this.pendingSteer = undefined;
    const steerLine = steer ? `\n\nSteering update from the user: "${steer}"` : "";
    // Name the tool the engine was actually given, not the literal `task_done`.
    // A run whose terminal tool is something else (a review's `submit_verdict`)
    // would otherwise be told to call a tool it does not have.
    const done = `\`${this.taskDone.name}\``;
    const intro = `Work step by step using your tools. Take ONE concrete action now. When — and only when — the GOAL is fully achieved, call the ${done} tool with a short summary.`;
    const cont = `Take the next concrete action now. If it is fully complete, call ${done} with a summary.`;
    // Eternal steps are fresh directives against one long history; the journal
    // is what stops step N from re-attempting exactly what steps N-1..N-5 did.
    const journal = this.journalBlock();
    if (this.step === 1) {
      return `You are now working autonomously toward this GOAL:\n"${this.goal}"\n\n${intro}${journal}${steerLine}`;
    }
    return `Continue toward the GOAL: "${this.goal}". ${cont}${journal}${steerLine}`;
  }

  /** Inject a steering note applied on the next step. */
  steer(note: string): void {
    const trimmed = note.trim();
    if (!trimmed) return;
    this.pendingSteer = this.pendingSteer ? `${this.pendingSteer}; ${trimmed}` : trimmed;
    this.bus.emit({ type: "autonomy_steer", note: trimmed });
  }

  pause(): void {
    if (this._state !== "running") return;
    this._state = "paused";
    this.resumeGate = new Promise((resolve) => {
      this.resumeResolve = resolve;
    });
    this.current?.abort();
    this.bus.emit({ type: "autonomy_paused" });
  }

  resume(): void {
    if (this._state !== "paused") return;
    this._state = "running";
    this.resumeResolve?.();
    this.resumeResolve = undefined;
    this.bus.emit({ type: "autonomy_resumed" });
  }

  stop(): void {
    if (this._state === "idle" || this._state === "done" || this._state === "stopped") return;
    this.stopped = true;
    this._state = "stopped";
    this.resumeResolve?.(); // unblock the gate if paused
    this.current?.abort();
    this.bus.emit({ type: "autonomy_stopped", reason: "stopped by user" });
    this.ckpt(true); // a deliberate stop is an end state — drop the checkpoint
  }

  private paused(): boolean {
    return this._state === "paused";
  }

  private async gate(): Promise<void> {
    if (this._state === "paused") await this.resumeGate;
  }

  private finish(summary: string): void {
    this._state = "done";
    this.bus.emit({ type: "autonomy_done", summary });
    this.ckpt(true); // goal complete — drop the checkpoint
  }
}
