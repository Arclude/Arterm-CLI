import type { Agent } from "./agent.js";
import type { EventBus } from "./eventBus.js";
import type { AutonomyMode, Tool } from "./types.js";

export type AutonomyState = "idle" | "running" | "paused" | "done" | "stopped";

export interface AutonomyOptions {
  mode?: AutonomyMode;
  /** Step cap for "once" mode (safety bound). Default 25. */
  maxSteps?: number;
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
  }

  get state(): AutonomyState {
    return this._state;
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
