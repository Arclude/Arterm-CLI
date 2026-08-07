/**
 * Long-running child processes, and the promise that they end.
 *
 * Every command the agent has run until now was awaited: it started, it
 * finished, the tool returned. Background execution breaks that, and what it
 * breaks is not convenience — it is the guarantee that closing a session closes
 * what the session started. A dev server the model launched in minute two of a
 * six-hour unattended run is still holding port 3000 tomorrow, and nothing in
 * the process tree remembers why.
 *
 * So the registry and the teardown hook ship in the same commit as the
 * background flag. Adding the ability to detach without adding the ledger is
 * adding the leak.
 *
 * What is recorded is REDACTED (`redactCommand`): the argv is shown by `/ps`,
 * read back by the model, and kept for the session, which are precisely the
 * places `scrubEnv` exists to keep a credential out of.
 */

import { redactCommand } from "./credentials.js";

export type ProcessState = "running" | "exited" | "killed" | "failed";

export interface ManagedProcess {
  /** Short handle the model and `/ps` use. */
  id: string;
  pid?: number;
  /** The command as recorded — redacted, and safe to print. */
  label: string;
  startedAt: number;
  endedAt?: number;
  state: ProcessState;
  exitCode?: number;
  /** Tail of the process's combined output, bounded. */
  output: string;
}

/** What the registry needs from a spawned child; kept narrow so tests can fake it. */
export interface ProcessHandle {
  pid?: number;
  kill(signal?: NodeJS.Signals): void;
}

/** Output bytes kept per process. The tail, because that is where a crash says why. */
const MAX_OUTPUT = 64 * 1024;

export interface ProcessRegistryOptions {
  /** Live processes allowed at once (default 16). */
  max?: number;
  onChange?(): void;
}

export class ProcessRegistry {
  private processes = new Map<string, ManagedProcess>();
  private handles = new Map<string, ProcessHandle>();
  private seq = 0;

  constructor(private opts: ProcessRegistryOptions = {}) {}

  private get max(): number {
    return this.opts.max ?? 16;
  }

  /** Processes that have not ended. */
  live(): ManagedProcess[] {
    return [...this.processes.values()].filter((p) => p.state === "running");
  }

  list(): ManagedProcess[] {
    return [...this.processes.values()].sort((a, b) => a.startedAt - b.startedAt);
  }

  get(id: string): ManagedProcess | undefined {
    return this.processes.get(id);
  }

  /**
   * Record a started process.
   *
   * Throws when the cap is reached rather than starting anyway: an unbounded
   * pile of background processes is the failure this exists to prevent, and a
   * cap that is exceeded silently is not one.
   */
  register(handle: ProcessHandle, argv: readonly string[]): ManagedProcess {
    if (this.live().length >= this.max) {
      throw new Error(
        `${this.max} background processes are already running. Stop one first (\`/ps\`).`,
      );
    }
    const record: ManagedProcess = {
      id: `p${++this.seq}`,
      label: redactCommand(argv).join(" "),
      startedAt: Date.now(),
      state: "running",
      output: "",
      ...(handle.pid !== undefined ? { pid: handle.pid } : {}),
    };
    this.processes.set(record.id, record);
    this.handles.set(record.id, handle);
    this.opts.onChange?.();
    return record;
  }

  /** Append to a process's output tail. */
  append(id: string, chunk: string): void {
    const record = this.processes.get(id);
    if (!record) return;
    record.output = `${record.output}${chunk}`.slice(-MAX_OUTPUT);
  }

  /** Record that a process ended on its own. */
  settle(id: string, exitCode: number | undefined, state: ProcessState = "exited"): void {
    const record = this.processes.get(id);
    if (!record || record.state !== "running") return;
    record.state = state;
    record.endedAt = Date.now();
    if (exitCode !== undefined) record.exitCode = exitCode;
    this.handles.delete(id);
    this.opts.onChange?.();
  }

  /** Stop one process. Returns the record, or undefined when there is no such id. */
  kill(id: string, signal: NodeJS.Signals = "SIGTERM"): ManagedProcess | undefined {
    const record = this.processes.get(id);
    if (!record) return undefined;
    const handle = this.handles.get(id);
    if (record.state === "running") {
      try {
        handle?.kill(signal);
      } catch {
        // Already gone; the record still moves to "killed".
      }
      record.state = "killed";
      record.endedAt = Date.now();
      this.handles.delete(id);
      this.opts.onChange?.();
    }
    return record;
  }

  /** Stop everything still running. The teardown hook; safe to call twice. */
  killAll(signal: NodeJS.Signals = "SIGTERM"): number {
    const running = this.live();
    for (const p of running) this.kill(p.id, signal);
    return running.length;
  }
}
