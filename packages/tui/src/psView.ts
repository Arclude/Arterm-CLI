/**
 * `/ps` — the user's half of background execution.
 *
 * Deliberately a slash command and not a tool. The model already has the ids
 * (`exec` and `bash` return them) and can stop a process by finishing its work;
 * what it cannot do is answer the question this is for — "what did you leave
 * running on my machine?" That question is the user's, and the answer must be
 * reachable without asking the model to look.
 *
 * Pure functions, so the formatting is testable without a terminal.
 */

import type { ManagedProcess } from "@arterm/core";

export type PsAction =
  | { kind: "list" }
  | { kind: "kill"; id: string }
  | { kind: "kill-all" }
  | { kind: "usage"; reason: string };

/** Parse the words after `/ps`. */
export function parsePsArgs(rest: readonly string[]): PsAction {
  const [verb, target] = rest;
  if (!verb) return { kind: "list" };
  if (verb !== "kill" && verb !== "stop") {
    return { kind: "usage", reason: `unknown action "${verb}"` };
  }
  if (!target) return { kind: "usage", reason: "`kill` needs a process id, or `all`" };
  return target === "all" ? { kind: "kill-all" } : { kind: "kill", id: target };
}

function age(from: number, to: number): string {
  const s = Math.max(0, Math.round((to - from) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m${s % 60}s` : `${Math.floor(m / 60)}h${m % 60}m`;
}

const STATE_MARK: Record<ManagedProcess["state"], string> = {
  running: "●",
  exited: "✓",
  killed: "■",
  failed: "✗",
};

/** The process table. `now` is a parameter so the output is deterministic in a test. */
export function formatProcesses(list: readonly ManagedProcess[], now: number): string {
  if (list.length === 0) {
    return "No background processes.\nStart one with `exec` or `bash` and `background: true`.";
  }
  const rows = list.map((p) => {
    const mark = STATE_MARK[p.state];
    const when = p.state === "running" ? age(p.startedAt, now) : age(p.startedAt, p.endedAt ?? now);
    const code = p.exitCode !== undefined ? ` (exit ${p.exitCode})` : "";
    return `  ${mark} ${p.id}  pid ${p.pid ?? "?"}  ${when.padStart(6)}  ${p.state}${code}\n      ${p.label}`;
  });
  const running = list.filter((p) => p.state === "running").length;
  return [
    ...rows,
    `  [${list.length} process(es), ${running} running — \`/ps kill <id>\` or \`/ps kill all\`]`,
  ].join("\n");
}

/** The tail of one process's output, for `/ps <id>`-style inspection. */
export function formatProcessOutput(p: ManagedProcess, maxLines = 40): string {
  const lines = p.output.split("\n");
  const shown = lines.slice(-maxLines);
  const head = `${p.id} ${p.label} — ${p.state}`;
  if (p.output.trim() === "") return `${head}\n(no output yet)`;
  const cut =
    lines.length > shown.length ? `… ${lines.length - shown.length} earlier line(s)\n` : "";
  return `${head}\n${cut}${shown.join("\n")}`;
}
