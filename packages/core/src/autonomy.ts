import type { Agent } from "./agent.js";
import type { EventBus } from "./eventBus.js";
import { availableRoles } from "./subagent.js";
import type { AutonomyMode, Tool } from "./types.js";

export type AutonomyState = "idle" | "running" | "paused" | "done" | "stopped";

/** One independent unit of parallel work the leader hands to a sub-agent. */
export interface AutonomyTask {
  task: string;
  role?: string;
}

/** A result returned by one parallel sub-agent. */
export interface AutonomyTaskResult extends AutonomyTask {
  output: string;
}

/** Runs a batch of tasks concurrently (sub-agent fleet) and returns ordered results. */
export type AutonomyFleetRunner = (
  tasks: AutonomyTask[],
  signal: AbortSignal,
) => Promise<AutonomyTaskResult[]>;

export interface AutonomyOptions {
  mode?: AutonomyMode;
  /** Step (or parallel-round) cap (safety bound). Default 25. */
  maxSteps?: number;
  /** Max independent subtasks per round in "parallel" mode. Default 16 (hard cap 16). */
  fanout?: number;
  /** Fleet runner required by "parallel" mode (injected so core stays decoupled). */
  runFleet?: AutonomyFleetRunner;
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
  private readonly runFleet?: AutonomyFleetRunner;
  private goal = "";
  private step = 0;
  private idleStreak = 0;
  private pendingSteer?: string;
  private stopped = false;
  private current?: AbortController;
  private resumeGate: Promise<void> = Promise.resolve();
  private resumeResolve?: () => void;

  constructor(
    private readonly agent: Agent,
    private readonly bus: EventBus,
    private readonly taskDone: Tool,
    opts: AutonomyOptions = {},
  ) {
    this.mode = opts.mode ?? "once";
    this.maxSteps = opts.maxSteps ?? 25;
    this.fanout = Math.min(16, Math.max(1, opts.fanout ?? 16));
    this.runFleet = opts.runFleet;
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

  /** Locks in a goal and runs the autonomous loop to completion (or stop). */
  async start(goal: string): Promise<void> {
    if (this._state === "running" || this._state === "paused") return;
    this.goal = goal.trim();
    this.step = 0;
    this.idleStreak = 0;
    this.stopped = false;
    this.pendingSteer = undefined;
    this._state = "running";
    this.bus.emit({ type: "goal_set", goal: this.goal, mode: this.mode });

    if (this.mode === "parallel") {
      try {
        await this.runParallelLoop();
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
