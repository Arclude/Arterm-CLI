/**
 * Lifecycle hooks: letting another program observe — and gate — what the agent
 * does, without forking us.
 *
 * The split is the same one telemetry, the chronicle and the sandbox use: this
 * file is the MAPPING (which seam becomes which hook, what a hook is handed, and
 * what its exit code means); the mechanism is a child process, and the wiring
 * into the loop is one `toolCall` middleware registered by the composition root.
 *
 * **Observers and one gate**, and the asymmetry is deliberate. `turn_end`,
 * `session_start`, `session_end` and `post_tool` are spawned detached and never
 * awaited: they cannot slow a turn down and cannot fail one. `pre_tool` runs
 * synchronously before a call and may block it, because "may this run?" is a
 * question that has to be answered before the answer stops mattering.
 *
 * **The gate FAILS OPEN**, matching `verify.ts`'s judge rather than the
 * sandbox's boundary. A hook is user-supplied policy living outside our tree: a
 * missing binary, a timeout, a syntax error or an unexpected exit code degrades
 * to "no policy" rather than bricking every session. Only an explicit `exit 2`
 * blocks. Someone who needs fail-closed semantics writes a hook that is robust —
 * it is their trust boundary, and a policy that silently becomes mandatory the
 * day it breaks is worse than one that says so.
 *
 * **A hook is a spawned command, so it is handed a SCRUBBED environment.** This
 * is ours, not borrowed: `credentials.ts` exists because `bash` was given the
 * keys the user gave to Arterm, and a hook is the same door with the same
 * keys behind it. `scrubEnv` with no settings still scrubs, so a hook runner
 * assembled without the plumbing is not the one path that hands them over.
 *
 * The command is run through `sh -c`, unlike the tool sandbox's argv wrapping,
 * and the reason is the same one `verify.command` relies on: a hook command
 * comes from the CONFIG FILE and can never come from model output. Where free
 * text becomes a command we quote defensively; where the user wrote the line
 * themselves, a shell is a feature — `turn_end = "notify-send x && tmux ..."`
 * is the shape people actually want.
 */

import { spawn } from "node:child_process";
import { type CredentialSettings, scrubEnv } from "./credentials.js";
import type { Middleware, ToolCallCtx } from "./kernel/pipeline.js";

/** The lifecycle points a hook can be attached to. */
export type HookEvent = "turn_end" | "session_start" | "session_end" | "pre_tool" | "post_tool";

export interface HookSettings {
  /** Shell command run when a turn completes (observer). */
  turnEnd?: string;
  /** Shell command run when a session becomes active (observer). */
  sessionStart?: string;
  /** Shell command run when a session closes (observer). */
  sessionEnd?: string;
  /** Shell command run BEFORE each tool call; `exit 2` blocks it (gate). */
  preTool?: string;
  /** Shell command run after each tool call (observer). */
  postTool?: string;
  /** How long the gate may take before it is treated as absent. */
  preToolTimeoutMs?: number;
}

/** Default gate timeout: long enough for a script, short enough not to be felt. */
export const DEFAULT_PRE_TOOL_TIMEOUT_MS = 5000;

/**
 * The payload cap, applied to every value that could carry model output.
 *
 * A tool's input is unbounded (a `write` call carries a whole file), and the
 * environment block has a hard size limit on every platform — `E2BIG` at spawn
 * time would turn a large edit into a session that cannot run tools at all.
 */
const MAX_ENV_VALUE = 16 * 1024;

/** The gate's stderr becomes a model-visible tool error, so it is bounded too. */
const MAX_GATE_REASON = 2000;

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

export interface HookContext {
  sessionId?: string;
  cwd?: string;
  /** Withheld from the child; absent still scrubs. */
  credentials?: CredentialSettings;
}

/**
 * The environment every hook receives.
 *
 * `ARTERM_HOOKS_DISABLED=1` is the recursion guard, and it is not optional: a
 * hook that calls the `arterm` CLI (to log a turn, to ask a question) would
 * otherwise fire the same hook again from inside itself, once per level, for as
 * long as the stack holds.
 */
function hookEnv(
  event: HookEvent,
  fields: Record<string, string>,
  ctx: HookContext,
): Record<string, string> {
  const { env } = scrubEnv(process.env, ctx.credentials);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) out[k] = v;
  out.ARTERM_HOOK_EVENT = event;
  out.ARTERM_HOOKS_DISABLED = "1";
  if (ctx.sessionId) out.ARTERM_HOOK_SESSION_ID = ctx.sessionId;
  if (ctx.cwd) out.ARTERM_HOOK_CWD = ctx.cwd;
  for (const [k, v] of Object.entries(fields)) out[k] = clip(v, MAX_ENV_VALUE);
  // The whole event as one JSON object, for hooks that would rather parse than
  // read a dozen variables — and the only form that survives adding a field.
  out.ARTERM_HOOK_PAYLOAD = clip(
    JSON.stringify({ event, sessionId: ctx.sessionId, cwd: ctx.cwd, ...fields }),
    MAX_ENV_VALUE,
  );
  return out;
}

/**
 * Fire-and-forget. Detached and unref'd so a hook that outlives the turn — or
 * hangs forever — cannot hold the process open at exit, which is the failure
 * `SandboxRunner.dispose()` was written for one layer down.
 */
export function runObserverHook(
  command: string,
  event: HookEvent,
  fields: Record<string, string>,
  ctx: HookContext,
): void {
  if (!command.trim()) return;
  try {
    const child = spawn("sh", ["-c", command], {
      cwd: ctx.cwd,
      env: hookEnv(event, fields, ctx),
      stdio: "ignore",
      detached: true,
    });
    // A spawn that fails asynchronously (missing `sh`, permissions) emits
    // "error"; with no listener that becomes an unhandled exception, which is a
    // fire-and-forget observer taking the session down with it.
    child.on("error", () => {});
    child.unref();
  } catch {
    // Observers never fail a run.
  }
}

export interface GateVerdict {
  blocked: boolean;
  /** The hook's stderr, handed to the MODEL as the tool error when blocked. */
  reason?: string;
}

/**
 * Runs the `pre_tool` gate and waits for it.
 *
 * The tool's input JSON goes to **stdin** as well as into the environment: the
 * environment copy is capped at 16 KB and a `write` call is routinely larger,
 * so stdin is the channel that carries the whole thing and the variable is the
 * convenience.
 */
export async function runGateHook(
  command: string,
  toolName: string,
  input: unknown,
  ctx: HookContext,
  timeoutMs = DEFAULT_PRE_TOOL_TIMEOUT_MS,
): Promise<GateVerdict> {
  if (!command.trim()) return { blocked: false };
  const json = safeJson(input);
  return await new Promise<GateVerdict>((resolve) => {
    let settled = false;
    const done = (v: GateVerdict): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("sh", ["-c", command], {
        cwd: ctx.cwd,
        env: hookEnv(
          "pre_tool",
          { ARTERM_HOOK_TOOL_NAME: toolName, ARTERM_HOOK_TOOL_INPUT: json },
          ctx,
        ),
        stdio: ["pipe", "ignore", "pipe"],
      });
    } catch {
      return done({ blocked: false });
    }
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
      // A gate that never answers is a gate that is not there. Blocking here
      // would make one slow script look exactly like a broken agent.
      done({ blocked: false });
    }, timeoutMs);
    let stderr = "";
    child.stderr?.on("data", (c) => {
      if (stderr.length < MAX_GATE_REASON * 2) stderr += String(c);
    });
    child.on("error", () => done({ blocked: false }));
    child.on("close", (code) => {
      // 2 and only 2 blocks. Every other code — including the 1 a careless
      // script returns from a failing `grep` — falls open, because a policy
      // that starts denying everything the day it breaks is worse than none.
      if (code === 2) {
        const reason = clip(stderr.trim(), MAX_GATE_REASON);
        done({ blocked: true, reason: reason || "blocked by the pre_tool hook" });
      } else {
        done({ blocked: false });
      }
    });
    try {
      // A gate that never reads stdin — `exit 2` on the first line, or a script
      // that ignores it entirely — makes this write fail with EPIPE, and that
      // failure is ASYNC: it arrives as an "error" event on the stream, long
      // after this try/catch has returned. With no listener it becomes an
      // unhandled exception, so the gate's own correct verdict takes the
      // session down with it. Same argument as the "error" listener on the
      // child above, one layer in.
      child.stdin?.on("error", () => {});
      child.stdin?.end(json);
    } catch {
      // A gate that closed stdin early still gets to answer.
    }
  });
}

/** Tool arguments are model output; a value that will not encode must not throw. */
function safeJson(input: unknown): string {
  try {
    return JSON.stringify(input ?? {}) ?? "{}";
  } catch {
    return "{}";
  }
}

/**
 * The `toolCall` middleware carrying both tool hooks.
 *
 * Registered `before("execute")`, NOT `before("permission")` where the chronicle
 * sits, and the difference is what each is for. The chronicle records the
 * DECISION, so it has to see denials. A gate answers "may this run?", and a call
 * the permission ladder already refused is not going to run — asking a user's
 * script about it would spawn a process per denial to re-refuse something.
 * `pre_tool` therefore sees exactly the calls that are about to execute, which
 * is also the seam the telemetry span brackets.
 *
 * A block short-circuits: `next()` is never called, so the tool does not run,
 * and the hook's stderr becomes the tool's error output. That is the same
 * mechanism `toolCall.permission` uses to deny, and the model reads the reason
 * and can adapt — which is the whole point of returning stderr rather than a
 * fixed string.
 */
export function hookToolCall(
  settings: HookSettings,
  ctx: () => HookContext,
): Middleware<ToolCallCtx> {
  const pre = settings.preTool?.trim();
  const post = settings.postTool?.trim();
  const timeout = settings.preToolTimeoutMs ?? DEFAULT_PRE_TOOL_TIMEOUT_MS;
  return async (callCtx, next) => {
    const name = callCtx.call.name;
    if (pre) {
      const verdict = await runGateHook(pre, name, callCtx.call.arguments, ctx(), timeout);
      if (verdict.blocked) {
        callCtx.output = verdict.reason ?? "blocked by the pre_tool hook";
        callCtx.isError = true;
        return; // no next(): the call never reaches `execute`
      }
    }
    const started = Date.now();
    try {
      await next();
    } finally {
      if (post) {
        runObserverHook(
          post,
          "post_tool",
          {
            ARTERM_HOOK_TOOL_NAME: name,
            ARTERM_HOOK_STATUS: callCtx.isError ? "error" : "ok",
            ARTERM_HOOK_DURATION_MS: String(Date.now() - started),
            ARTERM_HOOK_OUTPUT_BYTES: String(callCtx.output?.length ?? 0),
          },
          ctx(),
        );
      }
    }
  };
}

/** True when any hook is configured — the callers skip all payload work if not. */
export function hasAnyHook(settings?: HookSettings): boolean {
  if (!settings) return false;
  return Boolean(
    settings.turnEnd?.trim() ||
      settings.sessionStart?.trim() ||
      settings.sessionEnd?.trim() ||
      settings.preTool?.trim() ||
      settings.postTool?.trim(),
  );
}

/**
 * True when this process is itself running inside a hook.
 *
 * Read at the composition root so a nested `arterm` invoked BY a hook installs
 * none of its own — the guard has to be honoured by the reader, since an
 * environment variable only suppresses what looks at it.
 */
export function hooksSuppressed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ARTERM_HOOKS_DISABLED === "1";
}
