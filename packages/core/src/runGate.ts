export type RunGateState = "idle" | "running" | "paused" | "done" | "stopped";

/**
 * The pause/resume/stop micro-lifecycle shared by long-running drivers (e.g. the
 * /sdd runner). `await gate()` blocks while paused and resolves on resume/stop;
 * `stopped` is a one-way latch the driver checks between units of work.
 */
export class RunGate {
  private _state: RunGateState = "idle";
  private _stopped = false;
  private resumeGate: Promise<void> = Promise.resolve();
  private resumeResolve?: () => void;

  get state(): RunGateState {
    return this._state;
  }

  get stopped(): boolean {
    return this._stopped;
  }

  /** Mark the run active. Call at the start of a run. */
  begin(): void {
    this._state = "running";
    this._stopped = false;
  }

  pause(): void {
    if (this._state !== "running") return;
    this._state = "paused";
    this.resumeGate = new Promise((resolve) => {
      this.resumeResolve = resolve;
    });
  }

  resume(): void {
    if (this._state !== "paused") return;
    this._state = "running";
    this.resumeResolve?.();
    this.resumeResolve = undefined;
  }

  stop(): void {
    if (this._state === "idle" || this._state === "done" || this._state === "stopped") return;
    this._stopped = true;
    this._state = "stopped";
    this.resumeResolve?.();
    this.resumeResolve = undefined;
  }

  /** Mark the run finished (clean completion). */
  finish(): void {
    if (this._state === "running" || this._state === "paused") this._state = "done";
  }

  /** Block while paused; returns immediately otherwise. */
  async wait(): Promise<void> {
    if (this._state === "paused") await this.resumeGate;
  }
}
