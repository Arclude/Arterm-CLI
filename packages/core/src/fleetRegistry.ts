/**
 * A fleet the MODEL drives, rather than one the engine drives.
 *
 * `/team` and `/sdd` already fan out, but they decide the whole shape up front:
 * a roster, a wave, a graph cut from a spec. That is the right structure when
 * the work is known in advance and the wrong one when it is not — the model
 * cannot give a worker a follow-up, cannot ask one what it found, and cannot
 * combine two workers' answers without both passing through its own context.
 *
 * What was missing is not a way to spawn. `spawn` has always existed; it
 * BLOCKS, so the model's turn stops until the worker is done, and two workers
 * are two waits. The missing piece is a task record that outlives the call that
 * created it: assign, keep working, collect later.
 *
 * Three properties are deliberate:
 *
 * - **A worker is serial.** Two tasks running on one `SubagentSession` would
 *   braid two conversations into one history. Every worker has a queue and runs
 *   its tasks in order; concurrency is across workers, which is also the only
 *   kind a reader can reason about.
 * - **Results live here, not in the context.** A finished task's full output is
 *   held by the registry; the tool returns a clipped view and the id. That is
 *   the point of a fleet — five workers producing 20 KB each must not cost
 *   100 KB of the leader's window before the leader has decided what matters.
 * - **The fan-out is bounded.** `maxWorkers` is not a tuning knob. A worker that
 *   can spawn is a fan-out with nothing counting it, which is why
 *   `NEVER_SUBAGENT_TOOLS` exists; a LEADER that can spawn without limit is the
 *   same hole one level up.
 */

import { spoolOutput } from "./toolOutput.js";

export type WorkerState = "idle" | "busy" | "terminated";
export type FleetTaskState = "queued" | "running" | "done" | "failed" | "cancelled";

export interface FleetWorkerRecord {
  id: string;
  name: string;
  role?: string;
  state: WorkerState;
  createdAt: number;
  /** Tasks this worker finished, however they ended. */
  finished: number;
  /** Tool names this worker was restricted to, when it was. */
  tools?: string[];
}

export interface FleetTaskRecord {
  id: string;
  workerId: string;
  task: string;
  state: FleetTaskState;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  /** The worker's output. Present once the task leaves `running`. */
  result?: string;
  /** Where the full output was written when it was too large to keep in memory. */
  resultPath?: string;
}

/** What a caller must supply to make a worker; the host owns how agents are built. */
export interface WorkerSpec {
  id: string;
  name: string;
  role?: string;
  tools?: string[];
  /** Standing context prepended to the worker's first task. */
  brief?: string;
}

/** A live worker: something that takes tasks one at a time and can be stopped. */
export interface WorkerRunner {
  run(task: string, signal?: AbortSignal): Promise<string>;
  stop(): void;
}

export interface FleetRegistryOptions {
  /** Builds a worker. Injected so `core` stays out of how sessions are composed. */
  createWorker(spec: WorkerSpec): WorkerRunner;
  /** Live workers allowed at once (default 8). */
  maxWorkers?: number;
  /** Tasks a single worker may have waiting (default 16). */
  maxQueued?: number;
  /** Result bytes kept in memory before the full text is spooled to disk. */
  maxResultBytes?: number;
  /** Called on every worker/task state change — the board's feed. */
  onChange?(): void;
}

const DEFAULT_MAX_WORKERS = 8;
const DEFAULT_MAX_QUEUED = 16;
const DEFAULT_MAX_RESULT_BYTES = 262_144;

export class FleetRegistry {
  private readonly workers = new Map<string, FleetWorkerRecord>();
  private readonly runners = new Map<string, WorkerRunner>();
  private readonly aborts = new Map<string, AbortController>();
  /** Each worker's tail promise — the chain that makes its tasks serial. */
  private readonly queues = new Map<string, Promise<void>>();
  private readonly tasks = new Map<string, FleetTaskRecord>();
  /** Resolvers waiting on a task id, woken when it settles. */
  private readonly waiters = new Map<string, Array<() => void>>();
  private workerSeq = 0;
  private taskSeq = 0;

  constructor(private readonly opts: FleetRegistryOptions) {}

  private get maxWorkers(): number {
    return this.opts.maxWorkers ?? DEFAULT_MAX_WORKERS;
  }

  /** Workers that have not been terminated. */
  liveWorkers(): FleetWorkerRecord[] {
    return [...this.workers.values()].filter((w) => w.state !== "terminated");
  }

  listWorkers(): FleetWorkerRecord[] {
    return [...this.workers.values()];
  }

  listTasks(): FleetTaskRecord[] {
    return [...this.tasks.values()];
  }

  getTask(id: string): FleetTaskRecord | undefined {
    return this.tasks.get(id);
  }

  getWorker(id: string): FleetWorkerRecord | undefined {
    return this.workers.get(id);
  }

  /**
   * Create a worker WITHOUT running anything. No model call happens here — that
   * is the whole difference from `spawn`, and it is what lets the model set up
   * a fleet and then decide what to give it.
   */
  spawn(spec: Omit<WorkerSpec, "id"> & { id?: string }): FleetWorkerRecord {
    if (this.liveWorkers().length >= this.maxWorkers) {
      throw new Error(
        `fleet is full: ${this.maxWorkers} live workers. Terminate one, or collect finished work first.`,
      );
    }
    const id = spec.id ?? `w${++this.workerSeq}`;
    if (this.workers.has(id)) throw new Error(`worker ${id} already exists`);
    const record: FleetWorkerRecord = {
      id,
      name: spec.name,
      state: "idle",
      createdAt: Date.now(),
      finished: 0,
      ...(spec.role !== undefined ? { role: spec.role } : {}),
      ...(spec.tools !== undefined ? { tools: spec.tools } : {}),
    };
    this.workers.set(id, record);
    this.runners.set(id, this.opts.createWorker({ ...spec, id }));
    this.queues.set(id, Promise.resolve());
    this.opts.onChange?.();
    return record;
  }

  /**
   * Queue a task on a worker and return immediately.
   *
   * The returned record is `queued` or `running`; nothing here awaits the work.
   * A caller that wants the answer calls `awaitTasks`.
   */
  assign(workerId: string, task: string): FleetTaskRecord {
    const worker = this.workers.get(workerId);
    if (!worker) throw new Error(`no such worker: ${workerId}`);
    if (worker.state === "terminated") throw new Error(`worker ${workerId} was terminated`);

    const pending = this.listTasks().filter(
      (t) => t.workerId === workerId && (t.state === "queued" || t.state === "running"),
    );
    const maxQueued = this.opts.maxQueued ?? DEFAULT_MAX_QUEUED;
    if (pending.length >= maxQueued) {
      throw new Error(`worker ${workerId} already has ${pending.length} task(s) pending`);
    }

    const record: FleetTaskRecord = {
      id: `t${++this.taskSeq}`,
      workerId,
      task,
      state: "queued",
      createdAt: Date.now(),
    };
    this.tasks.set(record.id, record);

    // Chained onto the worker's tail, which is what serialises it. The chain is
    // never rejected: a failing task settles its own record and the next task
    // still runs, because one bad task must not silently stop a worker.
    const tail = this.queues.get(workerId) ?? Promise.resolve();
    this.queues.set(
      workerId,
      tail.then(() => this.execute(record)),
    );
    this.opts.onChange?.();
    return record;
  }

  private async execute(record: FleetTaskRecord): Promise<void> {
    const worker = this.workers.get(record.workerId);
    const runner = this.runners.get(record.workerId);
    // Terminated while it sat in the queue: settle it rather than run it.
    if (!worker || !runner || worker.state === "terminated" || record.state === "cancelled") {
      this.settle(record, "cancelled", "(cancelled before it started)");
      return;
    }

    const controller = new AbortController();
    this.aborts.set(record.workerId, controller);
    record.state = "running";
    record.startedAt = Date.now();
    worker.state = "busy";
    this.opts.onChange?.();

    try {
      const output = await runner.run(record.task, controller.signal);
      await this.settleWithResult(record, controller.signal.aborted ? "cancelled" : "done", output);
    } catch (err) {
      await this.settleWithResult(
        record,
        "failed",
        `worker ${record.workerId} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.aborts.delete(record.workerId);
      worker.finished++;
      // Re-read from the map rather than reusing `worker`: `terminate()` can
      // have run DURING the await above, and the compiler's narrowing from the
      // `= "busy"` before it would otherwise let this resurrect a worker the
      // caller just stopped.
      const live = this.workers.get(record.workerId);
      if (live && live.state !== "terminated") live.state = "idle";
      this.opts.onChange?.();
    }
  }

  private async settleWithResult(
    record: FleetTaskRecord,
    state: FleetTaskState,
    output: string,
  ): Promise<void> {
    const cap = this.opts.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES;
    if (Buffer.byteLength(output, "utf8") > cap) {
      // Held on disk rather than in the registry: a fleet is precisely the case
      // where several large results exist at once, and none of them has been
      // asked for yet.
      const path = await spoolOutput(output, `fleet-${record.id}`);
      if (path) record.resultPath = path;
    }
    this.settle(record, state, output);
  }

  private settle(record: FleetTaskRecord, state: FleetTaskState, output: string): void {
    record.state = state;
    record.result = output;
    record.endedAt = Date.now();
    const waiting = this.waiters.get(record.id);
    if (waiting) {
      this.waiters.delete(record.id);
      for (const wake of waiting) wake();
    }
    this.opts.onChange?.();
  }

  /** True once a task can no longer change. */
  private static settled(t: FleetTaskRecord): boolean {
    return t.state === "done" || t.state === "failed" || t.state === "cancelled";
  }

  /**
   * Wait for tasks to settle.
   *
   * `mode: "any"` returns as soon as one has, which is what makes a pipeline
   * possible: hand the first finished worker its next task while the others are
   * still going. A timeout returns what HAS settled rather than throwing — the
   * unfinished ones are still running and still collectable, and an exception
   * here would lose the ids.
   */
  async awaitTasks(opts: {
    taskIds?: string[];
    mode?: "all" | "any";
    timeoutMs?: number;
  }): Promise<{ settled: FleetTaskRecord[]; pending: FleetTaskRecord[]; timedOut: boolean }> {
    const mode = opts.mode ?? "all";
    // Named ids are watched as named, settled or not — asking for a finished
    // task's record is a legitimate way to collect it. With no ids the call
    // means "whatever is still outstanding", so already-finished work does not
    // make `any` return instantly with something the caller has already seen.
    const watched = opts.taskIds
      ? opts.taskIds.map((id) => this.tasks.get(id)).filter((t): t is FleetTaskRecord => !!t)
      : this.listTasks().filter((t) => !FleetRegistry.settled(t));

    if (watched.length === 0) {
      return { settled: [], pending: [], timedOut: false };
    }

    const done = () => watched.filter(FleetRegistry.settled);
    const satisfied = () => (mode === "any" ? done().length > 0 : done().length === watched.length);

    if (!satisfied()) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await new Promise<void>((resolve) => {
        let finished = false;
        const finish = () => {
          if (finished) return;
          finished = true;
          if (timer) clearTimeout(timer);
          resolve();
        };
        const check = () => {
          if (satisfied()) finish();
        };
        for (const t of watched) {
          if (FleetRegistry.settled(t)) continue;
          const list = this.waiters.get(t.id) ?? [];
          list.push(check);
          this.waiters.set(t.id, list);
        }
        if (opts.timeoutMs !== undefined) {
          timer = setTimeout(finish, Math.max(0, opts.timeoutMs));
          timer.unref?.();
        }
        check();
      });
    }

    const settled = done();
    return {
      settled,
      pending: watched.filter((t) => !FleetRegistry.settled(t)),
      timedOut: !satisfied(),
    };
  }

  /**
   * Stop a worker: abort what it is running and cancel what it had queued.
   *
   * The record survives termination on purpose — a fleet's history is how a
   * leader accounts for what it spent, and a terminated worker that vanished
   * would take its finished tasks' results with it.
   */
  terminate(workerId: string): FleetWorkerRecord | undefined {
    const worker = this.workers.get(workerId);
    if (!worker) return undefined;
    worker.state = "terminated";
    this.aborts.get(workerId)?.abort();
    this.runners.get(workerId)?.stop();
    for (const task of this.listTasks()) {
      if (task.workerId !== workerId) continue;
      if (task.state === "queued") this.settle(task, "cancelled", "(worker terminated)");
    }
    this.opts.onChange?.();
    return worker;
  }

  terminateAll(): number {
    const live = this.liveWorkers();
    for (const w of live) this.terminate(w.id);
    return live.length;
  }

  /** Teardown hook: stop everything. Safe to call more than once. */
  dispose(): void {
    this.terminateAll();
  }
}
