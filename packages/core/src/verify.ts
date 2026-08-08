/**
 * Result verification: one composite gate, two parts.
 *
 * A deterministic command runs first and **fails closed**; an LLM judge runs
 * behind it and **fails open**. That asymmetry is the whole design. A judge is a
 * model with an opinion — when it is unreachable, confused, or too small to emit
 * a tool call, accepting its silence costs nothing, while treating that silence
 * as a rejection turns every infrastructure hiccup into lost finished work. A
 * command's exit code is not an opinion, so it is allowed to block.
 *
 * The verdict travels as **structured data from a tool call**, never as prose to
 * be pattern-matched. This is not a stylistic preference. A sibling project
 * scrapes `## Verdict` out of Markdown, and its own bundled reviewer prompt emits
 * `## Verdict (approve / request changes / needs verification)` — which its
 * fail-first regex reads as a rejection every single time. Its fail-tokens also
 * match "0 tests failed" and "nothing red". Every miss is fail-closed, so each
 * one costs two judge spawns and an implementer pass in a repair loop that had
 * nothing to repair. The rule here is a presence check instead:
 *
 *     verdict !== undefined && verdict.pass === false
 *
 * is the only thing that can block. Its complement is acceptance, by construction.
 */

import { spawn } from "node:child_process";
import { type CredentialSettings, scrubEnv } from "./credentials.js";
import type { AgentEvent } from "./eventBus.js";

/** The tool the judge calls to deliver its verdict. */
export const VERDICT_TOOL_NAME = "submit_verdict";

/** Longest command a marker may declare — a guard against a pathological line. */
const MAX_COMMAND_CHARS = 400;

/** Caps on judge-supplied lists, in the spirit of the blackboard's entry caps. */
const MAX_ITEMS = 20;
const MAX_ITEM_CHARS = 500;

export interface Verdict {
  /** `false` is the ONLY thing that blocks. */
  pass: boolean;
  /** Human one-liner. Also what the judge sub-agent returns as its text output. */
  summary: string;
  /** Concrete items to address. Guaranteed non-empty when `pass` is false. */
  mustFix: string[];
  /** What the judge claims to have inspected. Reported, never gated on. */
  refs: string[];
}

export interface VerdictCapture {
  /** Present only when a usable verdict arrived. Absent ⇒ fail open. */
  verdict?: Verdict;
  /**
   * Tool calls the judge made *other* than the verdict — the cheap evidence
   * signal. A judge that inspected nothing almost always called nothing, and an
   * integer cannot misfire the way a "does this summary sound vague" regex can.
   */
  inspected: number;
  /** Verdict calls whose payload could not be normalized. */
  malformed: number;
  /** For display only. The pass/fail rule never reads this. */
  reason?: "not-submitted" | "malformed";
}

export interface VerdictSink {
  /** Pass straight to `SubagentOptions.onEvent`, or to `bus.on(...)`. */
  readonly onEvent: (event: AgentEvent) => void;
  /** Snapshot, after the run. */
  result(): VerdictCapture;
}

/**
 * Watch a bus for the judge's verdict call.
 *
 * Deliberately upstream of the permission pipeline: `tool_call` is emitted before
 * any gate runs, whereas a capture filled from inside `execute` sits *below*
 * permission checks and a middleware short-circuit — so a denied or intercepted
 * call would silently produce no verdict, and under fail-open a real rejection
 * would become an acceptance. The trade is that a *denied* verdict still counts,
 * which cannot happen for an allow/read tool and is the safe direction anyway.
 */
export function captureVerdict(toolName: string = VERDICT_TOOL_NAME): VerdictSink {
  let verdict: Verdict | undefined;
  let inspected = 0;
  let malformed = 0;

  return {
    onEvent(event) {
      if (event.type !== "tool_call") return;
      if (event.call.name !== toolName) {
        inspected += 1;
        return;
      }
      const parsed = normalizeVerdict(event.call.arguments);
      if (!parsed) {
        malformed += 1;
        return;
      }
      // First verdict wins: a second call cannot soften the first.
      verdict ??= parsed;
    },
    result() {
      return {
        ...(verdict ? { verdict } : {}),
        inspected,
        malformed,
        ...(verdict
          ? {}
          : { reason: malformed > 0 ? ("malformed" as const) : ("not-submitted" as const) }),
      };
    },
  };
}

/**
 * Coerce a verdict payload. Returns `undefined` ONLY when `pass` is unresolvable.
 *
 * Every rule here is a place a text-scraping parser guesses. `pass` accepts a real
 * boolean, plus the exact strings `"true"`/`"false"` because the JSON tool-call
 * fallback can carry a quoted boolean from a weak local model. Nothing else:
 * `1`, `"yes"`, `"PASS"` are rejected, because token-matching a verdict word is
 * precisely the failure this module exists to avoid.
 *
 * The asymmetry that matters: a rejection survives sloppiness and is never
 * upgraded. `pass: false` with no `mustFix` still blocks, with a synthesized item;
 * an empty or terse `summary` never invalidates it.
 */
export function normalizeVerdict(args: Record<string, unknown>): Verdict | undefined {
  const pass = coerceBool(args.pass);
  if (pass === undefined) return undefined;

  const summary = typeof args.summary === "string" ? args.summary.trim() : "";
  const mustFix = coerceList(args.mustFix ?? args.must_fix);
  const refs = coerceList(args.refs);

  return {
    pass,
    summary,
    // A blocking verdict with nothing actionable is still blocking — the worker
    // gets the summary to work from rather than the rejection being dropped.
    mustFix:
      pass || mustFix.length > 0
        ? mustFix
        : [summary || "the reviewer rejected this result without naming a reason"],
    refs,
  };
}

function coerceBool(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  const s = value.trim().toLowerCase();
  if (s === "true") return true;
  if (s === "false") return false;
  return undefined;
}

function coerceList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const s = item.trim();
    if (s) out.push(s.slice(0, MAX_ITEM_CHARS));
    if (out.length >= MAX_ITEMS) break;
  }
  return out;
}

export interface VerdictDecision {
  pass: boolean;
  /** False when nothing judged this — "unverified", which is not "verified". */
  judged: boolean;
  feedback: string;
  mustFix: string[];
}

/**
 * The rule, as one pure function. An explicit negative verdict blocks; everything
 * else — never submitted, malformed, provider dead, aborted — passes.
 */
export function decideVerdict(capture: VerdictCapture): VerdictDecision {
  const { verdict } = capture;
  if (!verdict) {
    return {
      pass: true,
      judged: false,
      feedback:
        capture.reason === "malformed"
          ? "the reviewer's verdict could not be read"
          : "no reviewer verdict arrived",
      mustFix: [],
    };
  }
  if (verdict.pass) {
    // A pass from a judge that opened nothing is still a pass, but say so: the
    // signal is an integer, so it can be reported without ever blocking on it.
    const thin = capture.inspected === 0 ? " (judge inspected nothing)" : "";
    return { pass: true, judged: true, feedback: `${verdict.summary}${thin}`.trim(), mustFix: [] };
  }
  return {
    pass: false,
    judged: true,
    feedback: verdict.summary || "the reviewer rejected this result",
    mustFix: verdict.mustFix,
  };
}

/** The `execute` echo, shared so the tool and its tests agree on the wording. */
export function formatVerdictEcho(args: Record<string, unknown>): {
  output: string;
  isError?: boolean;
} {
  const v = normalizeVerdict(args);
  if (!v) {
    return {
      output:
        `verdict rejected: "pass" must be true or false, got ${JSON.stringify(args.pass)}. ` +
        `Call ${VERDICT_TOOL_NAME} again with a boolean.`,
      isError: true,
    };
  }
  return {
    output: v.pass
      ? "✓ verdict recorded: PASS"
      : `✓ verdict recorded: FAIL — ${v.mustFix.length} item(s) to fix`,
  };
}

// ── The composite gate ────────────────────────────────────────────────────────

export interface VerifyRequest {
  /** The goal, or a task's title + description. */
  goal: string;
  /** The completion claim under review. */
  claim: string;
  /**
   * What the claim is measured against — a phase's `done`, a task's description.
   * The deterministic gate looks for its marker HERE; falls back to `goal`.
   */
  spec?: string;
  /** Where a declared command runs. Must be the tree the worker actually wrote to. */
  cwd?: string;
  /**
   * What the run was RECORDED doing, as opposed to what it claims.
   *
   * Supplied by the caller from the chronicle. It closes the hole this file's
   * own header describes — the judge reads the result and never the diff, so it
   * cannot catch work that contradicts the goal. A worker rewrote `slug()`,
   * committed it as `docs(…)`, and the judge passed it saying the behaviour was
   * untouched; the ledger would have shown the file and its new digest.
   *
   * Presented to the judge as evidence, never as a verdict. The asymmetry this
   * file is built on does not move: the judge still decides, and still fails
   * open. What changes is that "concrete evidence" — which the instruction
   * demands before any rejection — is now something it actually has.
   */
  evidence?: string;
  signal?: AbortSignal;
}

export interface VerifyResult {
  pass: boolean;
  /** Why, when a part had something to say. */
  reason?: string;
  mustFix?: string[];
  /** Which part decided. */
  by?: "command" | "judge";
  /** True when no verdict could be obtained and the claim passed by default. */
  skipped?: boolean;
}

export type Verifier = (req: VerifyRequest) => Promise<VerifyResult>;

/**
 * AND-compose: run in order, first failure wins, later parts are skipped.
 *
 * On an all-pass the composite reports **who actually decided**, because "verified"
 * and "nothing could verify this" must stay distinguishable downstream — a caller
 * that cannot tell them apart shows a green checkmark for an unreachable judge.
 * A part that really judged wins over one that was skipped; when nothing judged,
 * the skip is reported as the outcome.
 */
export function makeCompositeVerifier(parts: readonly Verifier[]): Verifier {
  return async (req) => {
    let decided: VerifyResult | undefined;
    let skipped: VerifyResult | undefined;
    for (const part of parts) {
      const outcome = await part(req);
      if (!outcome.pass) return outcome;
      if (outcome.skipped) skipped ??= outcome;
      else if (outcome.by) decided = outcome;
    }
    return decided ?? skipped ?? { pass: true };
  };
}

/**
 * The one place free text becomes a command — this function is the feature's
 * security boundary.
 *
 * A whole line reading exactly `verify: <cmd>` (or `$ <cmd>`), nothing else.
 * Prose that merely contains the word "verify", a marker with an empty body, a
 * bare `$`, `"$5 and up"` — none of them yield a command. Only the first marker
 * is honored, and never more than one line of it.
 */
export function extractVerifyCommand(text: string | undefined): string | undefined {
  if (!text) return undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const match = /^(?:verify\s*:|check\s*:|\$)\s*(.+)$/i.exec(line);
    if (!match) continue;
    const cmd = match[1]?.trim();
    // A body that is only punctuation is a false positive, not a command.
    if (!cmd || cmd.length > MAX_COMMAND_CHARS || !/[a-z0-9]/i.test(cmd)) continue;
    return cmd;
  }
  return undefined;
}

/**
 * How to hand a command string to a shell so the SHELL interprets it and Node
 * does not — per platform, as a ready-to-spawn argv.
 *
 * Windows needs the exact recipe Node itself uses for `shell: true`:
 * `cmd.exe /d /s /c "<command>"` with `windowsVerbatimArguments`. The naive
 * `cmd /d /c <command>` sends the command through Node's argv escaping, which
 * mangles anything containing quotes — `node -e "process.exit(3)"` arrived at
 * cmd rewritten badly enough that it **exited 0**. That made the deterministic
 * gate PASS on Windows no matter what the command did: `--verify-cmd` was
 * decorative there, and a gate that fails open is worse than no gate at all.
 * `/s` is what makes the wrapping quotes mean "strip the first and last, take
 * the rest verbatim"; without it cmd re-parses the inner quotes.
 */
export function verificationShell(
  platform: NodeJS.Platform,
  command: string,
): { file: string; args: string[]; windowsVerbatimArguments: boolean } {
  if (platform === "win32") {
    return {
      file: "cmd.exe",
      args: ["/d", "/s", "/c", `"${command}"`],
      windowsVerbatimArguments: true,
    };
  }
  return { file: "sh", args: ["-c", command], windowsVerbatimArguments: false };
}

export interface CommandVerifierOptions {
  /** Default cwd for a declared command. */
  cwd: string;
  /** Kill and fail the command after this long. */
  timeoutMs?: number;
  /**
   * Command to run when the work declares none — the session's standing gate
   * (`verify.command`). **Configuration only.** A declared `verify:` line still
   * wins, so a model narrows this gate to its own task and can never widen or
   * remove it; without a marker the fallback is what runs.
   */
  defaultCommand?: string;
  /**
   * Env hygiene for the spawned command (see `credentials.ts`). This is the
   * sharper instance of the same leak `bash` had, for two reasons: the command
   * can come from MODEL OUTPUT via `extractVerifyCommand`, and it is spawned
   * directly rather than through the sandbox — so under `--autonomous` it is
   * the one command that runs outside the boundary. Its stdout is ignored, so
   * nothing reaches the transcript; what a full environment would still buy is
   * an outbound `curl` carrying the session's keys. Omitted still scrubs.
   */
  credentials?: CredentialSettings;
}

/**
 * Run a task's verification command: the one it declared, else the session's
 * configured fallback, else nothing. The command is never *invented* — it comes
 * from the work's own `verify:` marker or from the config file. Exit 0 passes,
 * and **anything else fails closed** — this is the deterministic half, so it is
 * allowed to block.
 */
export function makeCommandVerifier(opts: CommandVerifierOptions): Verifier {
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const fallback = opts.defaultCommand?.trim() || undefined;

  return async (req) => {
    const cmd = extractVerifyCommand(req.spec) ?? extractVerifyCommand(req.goal) ?? fallback;
    if (!cmd) return { pass: true };
    if (req.signal?.aborted) return { pass: true, skipped: true, by: "command" };

    const cwd = req.cwd ?? opts.cwd;
    return await new Promise<VerifyResult>((resolve) => {
      // The command goes to the shell as ONE positional argument rather than via
      // `shell: true`, which would let Node interpolate the whole string and turn
      // any metacharacter into an injection vector. `sh -c "<cmd>"` hands the
      // full string to the shell, which is the thing that should interpret it.
      // (Windows takes the verbatim cmd.exe recipe — see verificationShell.)
      const sh = verificationShell(process.platform, cmd);
      const child = spawn(sh.file, sh.args, {
        cwd,
        shell: false,
        windowsHide: true,
        stdio: "ignore",
        // `spawn` inherits `process.env` when `env` is omitted, so this has to
        // be passed explicitly — the same withholding `bash` does, on the one
        // command a model can name that never crosses the sandbox.
        env: scrubEnv(process.env, opts.credentials).env,
        ...(sh.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
        // Kill the process TREE, not just the shell: `sh -c "pnpm test"` leaves an
        // orphaned node behind otherwise. Same reasoning (and the same platform
        // split) as the shell tool — see packages/tools/src/bash.ts.
        detached: process.platform !== "win32",
      });

      let settled = false;
      const finish = (result: VerifyResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const killTree = (): void => {
        if (!child.pid) return;
        if (process.platform === "win32") {
          spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" }).unref();
        } else {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        }
      };

      const timer = setTimeout(() => {
        killTree();
        finish({ pass: false, by: "command", reason: `verification timed out: ${cmd}` });
      }, timeoutMs);
      timer.unref?.();

      child.on("exit", (code) => {
        finish(
          code === 0
            ? { pass: true, by: "command" }
            : {
                pass: false,
                by: "command",
                reason: `verification failed (exit ${code}): ${cmd}`,
                mustFix: [`\`${cmd}\` must exit 0 — it exited ${code}`],
              },
        );
      });
      child.on("error", (err) => {
        finish({
          pass: false,
          by: "command",
          reason: `verification could not run: ${String(err)}`,
        });
      });
    });
  };
}

/** Runs one isolated judge turn and reports what it delivered. Never throws. */
export type JudgeRun = (prompt: string, signal?: AbortSignal) => Promise<VerdictCapture>;

export interface JudgeVerifierOptions {
  run: JudgeRun;
  /** Cap on the claim excerpt in the prompt. */
  maxClaimChars?: number;
}

/**
 * Ask a judge whether the claim holds. **Fails open**: a throw or a missing
 * verdict accepts the claim and reports `skipped`, so a flaky judge can never
 * wedge a run. The deterministic command gate is the backstop.
 */
export function makeJudgeVerifier(opts: JudgeVerifierOptions): Verifier {
  const maxClaimChars = opts.maxClaimChars ?? 4000;
  return async (req) => {
    let capture: VerdictCapture;
    try {
      capture = await opts.run(buildJudgeInstruction({ ...req, maxClaimChars }), req.signal);
    } catch {
      return {
        pass: true,
        by: "judge",
        skipped: true,
        reason: "the reviewer could not be reached",
      };
    }
    const decision = decideVerdict(capture);
    if (!decision.judged) {
      return { pass: true, by: "judge", skipped: true, reason: decision.feedback };
    }
    return decision.pass
      ? { pass: true, by: "judge", reason: decision.feedback }
      : { pass: false, by: "judge", reason: decision.feedback, mustFix: decision.mustFix };
  };
}

/**
 * The judge's prompt. Biased toward acceptance on purpose: the default target is
 * a small local model, and an over-strict judge burns repair rounds on doubt
 * rather than defects. The deterministic gate carries the weight that matters.
 */
export function buildJudgeInstruction(
  req: VerifyRequest & { maxClaimChars?: number; previousMustFix?: readonly string[] },
): string {
  const cap = req.maxClaimChars ?? 4000;
  const lines = [
    "You are an independent reviewer working in a fresh context. Judge one completed piece of work.",
    `THE GOAL WAS:\n${req.goal}`,
  ];
  if (req.spec && req.spec !== req.goal) lines.push(`ACCEPTANCE CRITERIA:\n${req.spec}`);
  lines.push(`THE WORKER CLAIMS:\n${req.claim.slice(0, cap) || "(no claim text)"}`);
  if (req.evidence) {
    // Named as the RECORD and placed after the claim, so the two are read
    // against each other. The digests were taken from disk by the tool layer,
    // which is the one part of this prompt the worker did not author.
    lines.push(
      `WHAT WAS RECORDED (a ledger of the tool calls, independent of the claim — file digests were read from disk, not reported by the worker):\n${req.evidence}`,
      "If the claim and the record disagree — a file the claim never mentions, a file it " +
        "says it changed that is absent here, a change credited to the wrong worker — that " +
        "IS the concrete evidence a rejection needs. A record that merely says less than the " +
        "claim is not: it covers file writes and nothing else.",
    );
  }
  if (req.previousMustFix?.length) {
    lines.push(
      `A previous review required these fixes. Check EACH one specifically, then confirm nothing was broken in the process:\n${req.previousMustFix.map((m) => `- ${m}`).join("\n")}`,
    );
  }
  lines.push(
    "Inspect the repository with your read-only tools before deciding.",
    `Report by calling \`${VERDICT_TOOL_NAME}\` exactly once. Do not answer in prose — a reply that does not call the tool is discarded and the work is accepted unreviewed.`,
    "Reject ONLY when you can point at concrete evidence: a missing file, an unimplemented " +
      "function, a stub, a contradiction with the criteria. Vague doubt is a pass. When you " +
      "reject, every `mustFix` entry must name a file and what to change.",
  );
  return lines.join("\n\n");
}
