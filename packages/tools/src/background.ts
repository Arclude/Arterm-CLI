/**
 * Starting a child that outlives the tool call.
 *
 * Shared by `exec` and `bash` so there is one answer to the three questions a
 * detached process raises — who kills it, what is recorded, and what happens to
 * its output — rather than two that drift.
 */

import type { ManagedProcess, ProcessRegistry, ToolContext } from "@arterm/core";
import { scrubEnv } from "@arterm/core";

/** Kill the whole process GROUP on POSIX, the tree on Windows. */
export function killTree(
  child: { pid?: number; kill(s?: NodeJS.Signals): void },
  signal?: NodeJS.Signals,
): void {
  if (!child.pid) {
    child.kill(signal);
    return;
  }
  if (process.platform === "win32") {
    void import("execa").then(({ execa }) =>
      execa("taskkill", ["/pid", String(child.pid), "/T", "/F"], { reject: false }),
    );
    return;
  }
  try {
    // Negative pid = the group. A dev server that forked a watcher is two
    // processes, and killing only the one we can see leaves the port held.
    process.kill(-child.pid, signal ?? "SIGTERM");
  } catch {
    child.kill(signal);
  }
}

export interface BackgroundSpec {
  /** argv to spawn, already sandbox-wrapped when a boundary is in force. */
  spawn: string[];
  /** What to RECORD — the user's command, not the wrapper's argv. */
  label: readonly string[];
  /** True when `spawn` should go through a shell (the `bash` path). */
  shell?: boolean;
  env?: Record<string, string | undefined>;
}

/**
 * Spawn detached, register, and return the record.
 *
 * The registration is not bookkeeping: it is the only thing that makes the
 * session's teardown able to stop what the session started. A background
 * command that is not registered is a leak with a friendly interface.
 */
export async function startBackground(
  spec: BackgroundSpec,
  ctx: ToolContext,
  registry: ProcessRegistry,
): Promise<ManagedProcess> {
  const { execa } = await import("execa");
  const { env } = scrubEnv({ ...process.env, ...(spec.env ?? {}) }, ctx.credentials);
  const options = {
    cwd: ctx.cwd,
    reject: false as const,
    all: true as const,
    env,
    extendEnv: false as const,
    detached: process.platform !== "win32",
    buffer: false as const,
  };
  const child = spec.shell
    ? execa(spec.spawn.join(" "), { ...options, shell: true })
    : execa(spec.spawn[0] as string, spec.spawn.slice(1), options);

  const record = registry.register(
    { ...(child.pid !== undefined ? { pid: child.pid } : {}), kill: (s) => killTree(child, s) },
    spec.label,
  );
  child.all?.on("data", (chunk: Buffer) => registry.append(record.id, chunk.toString("utf8")));
  child.on("exit", (code) => registry.settle(record.id, code ?? undefined));
  child.on("error", (err) => {
    registry.append(record.id, `\n${err.message}`);
    registry.settle(record.id, undefined, "failed");
  });
  // Nothing awaits this child; without a handler its rejection is unhandled and
  // takes the process down.
  void child.catch(() => {});
  return record;
}

/** The line a tool returns after starting something in the background. */
export function startedNote(record: ManagedProcess): string {
  const life = "It runs until it exits, you stop it with `/ps`, or the session ends.";
  return `Started ${record.id} (pid ${record.pid ?? "?"}): ${record.label}\n${life}`;
}
