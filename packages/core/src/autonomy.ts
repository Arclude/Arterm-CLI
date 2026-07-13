import type { Agent } from "./agent.js";
import { listAgentDefinitions } from "./agentRegistry.js";
import type { Blackboard } from "./blackboard.js";
import type { EventBus } from "./eventBus.js";
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

export type AutonomyState = "idle" | "running" | "paused" | "done" | "stopped";

/** One independent unit of parallel work the leader hands to a sub-agent. */
export interface AutonomyTask {
  task: string;
  role?: string;
  /** Stable team-member id (team mode) — threaded through fleet events. */
  id?: string;
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
  }

  get state(): AutonomyState {
    return this._state;
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
  snapshot(): {
    state: AutonomyState;
    mode: AutonomyMode;
    goal: string;
    step: number;
    phases: { id: string; title: string; done: string; parallel?: boolean }[];
    team: { id: string; name: string; description: string; adhoc: boolean }[];
  } {
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
    this.stopped = false;
    this.pendingSteer = undefined;
    this._phases = [];
    this._team = [];
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
      while (!this.stopped && (eternal || this.step < this.maxSteps)) {
        await this.gate();
        if (this.stopped) break;

        this.step += 1;
        this.bus.emit({ type: "autonomy_step", step: this.step });

        const { sawTool, doneSummary } = await this.runStep();
        if (this.stopped) break;
        if (this.paused()) continue; // paused mid-step; re-gate at loop top

        if (doneSummary !== undefined && !eternal) {
          this.finish(doneSummary);
          return;
        }

        if (!sawTool) {
          // Model produced no actions — reflect on whether we're actually done.
          const verdict = await this.agent.assess(this.goal, this.current?.signal);
          this.bus.emit({ type: "autonomy_reflect", done: verdict.done, note: verdict.note });
          if (verdict.done && !eternal) {
            this.finish(verdict.note || "goal complete");
            return;
          }
          this.idleStreak += 1;
          if (this.idleStreak >= 2 && !eternal) {
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
        // Hit the step cap in "once" mode.
        this._state = "stopped";
        this.bus.emit({
          type: "autonomy_stopped",
          reason: `reached step limit (${this.maxSteps})`,
        });
      }
    } finally {
      // Remove the injected task_done tool, restoring the normal tool set.
      this.agent.setTools(this.agent.tools.filter((t) => t.name !== this.taskDone.name));
      if (this._state === "running") this._state = "stopped";
    }
  }

  /** Runs one agent turn, watching the bus for tool activity + task_done. */
  private async runStep(): Promise<{ sawTool: boolean; doneSummary?: string }> {
    let sawTool = false;
    let doneSummary: string | undefined;
    const off = this.bus.on((e) => {
      if (e.type === "tool_call") {
        sawTool = true;
        if (e.call.name === this.taskDone.name) {
          doneSummary = String(e.call.arguments.summary ?? "");
        }
      }
    });
    this.current = new AbortController();
    try {
      await this.agent.run(this.stepPrompt(), this.current.signal);
    } finally {
      off();
    }
    return { sawTool, doneSummary };
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
    while (!this.stopped && round < this.maxSteps) {
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
          this.finish(verdict.note || "goal complete");
          return;
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

      await this.aggregate(round, results);
      this.bus.emit({ type: "autonomy_aggregate", round, count: results.length });

      const verdict = await this.agent.assess(this.goal, this.current.signal);
      this.bus.emit({ type: "autonomy_reflect", done: verdict.done, note: verdict.note });
      if (verdict.done) {
        this.finish(verdict.note || "goal complete");
        return;
      }
    }
    if (!this.stopped) {
      this._state = "stopped";
      this.bus.emit({ type: "autonomy_stopped", reason: `reached round limit (${this.maxSteps})` });
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
          summary();
          this.finish(verdict.note || "goal complete");
          return;
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
      // ad-hoc members get their brief as a task-instruction prefix. When a
      // blackboard is active, prefix each task with the digest meant for that
      // member (teammate results + messages addressed to it from earlier rounds).
      const tasks: AutonomyTask[] = assignments.map((a) => {
        const brief = this.blackboard?.briefFor(a.member.id);
        const task = brief ? `${brief}\n\n${a.task}` : a.task;
        return {
          task,
          role: a.member.name,
          id: a.member.id,
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

      // Post each member's result to the board so teammates read it next round,
      // and surface the flow as a team_message event (topology graph). Failed
      // slots hold an error string — not useful shared context, so skip them.
      if (this.blackboard) {
        for (const r of results) {
          if (r.error || !r.id) continue;
          const name = r.role ?? "member";
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
      }

      await this.aggregate(round, results);
      this.bus.emit({ type: "autonomy_aggregate", round, count: results.length });

      const verdict = await this.agent.assess(this.goal, this.current.signal);
      this.bus.emit({ type: "autonomy_reflect", done: verdict.done, note: verdict.note });
      if (verdict.done) {
        summary();
        this.finish(verdict.note || "goal complete");
        return;
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

      const summary = await this.runPhase(phase, i, phases.length, handoff);
      if (this.stopped) return;

      handoff = summary;
      this.bus.emit({ type: "phase_done", id: phase.id, index: i, title: phase.title, summary });
    }

    const verdict = await this.agent.assess(this.goal, this.current?.signal);
    this.finish(verdict.note || handoff || "all phases complete");
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
Reply with ONLY a JSON array shaped like ${jsonShape}, where "done" states how to know that phase is complete.${steerLine}`;
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
      tasks = this.parseTasks(raw);
      if (tasks.length === 0) tasks = [{ task: context }];
    } else {
      // Single focused sub-agent gets the full phase context incl. the handoff.
      tasks = [{ task: context }];
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
    return this.parseTasks(raw);
  }

  /** Tolerant parse of the leader's decomposition: first JSON array, validated + capped. */
  private parseTasks(raw: string): AutonomyTask[] {
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
      out.push({ task: task.trim(), role });
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
    const intro =
      "Work step by step using your tools. Take ONE concrete action now. When — and only when — " +
      "the GOAL is fully achieved, call the `task_done` tool with a short summary.";
    const cont =
      "Take the next concrete action now. If it is fully complete, call `task_done` with a summary.";
    if (this.step === 1) {
      return `You are now working autonomously toward this GOAL:\n"${this.goal}"\n\n${intro}${steerLine}`;
    }
    return `Continue toward the GOAL: "${this.goal}". ${cont}${steerLine}`;
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
  }
}
