import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { PermissionMode } from "./permissions.js";
import type { AutonomyMode, PermissionLevel, TrustTier } from "./types.js";

export interface ArtermConfig {
  /** Active provider id ("ollama" | "llamacpp"). */
  provider: string;
  /** Active model name (Ollama tag, or a .gguf filename for llamacpp). */
  model: string;
  /** Base URL for the Ollama server. */
  ollamaHost: string;
  /** Base URL (including /v1) for an OpenAI-compatible server (LM Studio, vLLM, ...). */
  openaiCompatHost: string;
  /**
   * Extra headers for the openai-compat provider (e.g. a User-Agent for relay
   * gateways that gate on a recognized client).
   */
  openaiCompatHeaders: Record<string, string>;
  /** Directory holding .gguf files for direct loading. */
  modelsDir: string;
  /**
   * Models to fall back to, in order, when the active one fails with a retryable
   * error (quota, overload, outage, dropped connection) — and only before any
   * output has been produced. Empty (the default) keeps the single-model path.
   *
   * `provider` defaults to the active one, so `[{ model: "llama3" }]` is a
   * same-provider fallback and `[{ provider: "anthropic", model: "…" }]` crosses
   * vendors. A cross-vendor target needs its own credentials configured.
   */
  fallbackModels: Array<{ provider?: string; model: string }>;
  /** Sampling temperature. */
  temperature: number;
  /** Per-tool permission overrides, persisted by "always allow". */
  permissions: Record<string, PermissionLevel>;
  /** Default permission mode (ask | auto | plan | yolo). */
  mode: PermissionMode;
  /** On-disk session transcript logging + retention. */
  session: {
    /** "off" = never write transcripts (default); "jsonl" = one file per session. */
    mode: "off" | "jsonl";
    /** Keep at most this many most-recent sessions. */
    maxSessions?: number;
    /** Delete sessions older than this many days. */
    maxAgeDays?: number;
  };
  /** Conversation context-window compaction. */
  context: {
    /** "none" = never compact; "window" = keep a recent slice; "summary" = recap older turns via the model. */
    strategy: "none" | "window" | "summary";
    /** Model context window in tokens, used to decide when to auto-compact. */
    window?: number;
    /** Compact once usage crosses this fraction of `window` (0–1). */
    compactAtPercent?: number;
    /** Window strategy: keep at most this many recent messages. */
    maxMessages?: number;
    /** Replace stale tool outputs with placeholders before compaction (default true). */
    clearToolResults?: boolean;
    /** Clear once usage crosses this fraction of `window` (default 0.6). */
    clearAtPercent?: number;
    /** Never clear the newest N tool results (default 3). */
    keepRecentToolResults?: number;
  };
  /** Per-turn spend guards for the agent loop. */
  budget: {
    /**
     * Stop the turn once the summed prompt+completion tokens of its iterations
     * cross this cap (each iteration re-bills the prompt, so the sum is the real
     * cost). Unset = no token cap; the iteration cap still applies.
     */
    turnTokens?: number;
    /**
     * Tool round-trips allowed in one turn (default 50).
     *
     * This is a runaway guard, not a work budget: hitting it ends the turn with a
     * `run_limit` event and a "send a message to continue" hint, so the only cost
     * of a generous value is how long a genuinely stuck loop runs — and repeated
     * identical calls are separately caught by the loop guard. A real task (read
     * a few files, grep, edit, run tests, fix) routinely needs dozens, so a tight
     * cap shows up as answers that stop mid-thought rather than as safety.
     */
    maxIterations?: number;
    /**
     * Whole-RUN ceilings, as opposed to the per-turn caps above — the thing
     * that bounds an unattended run in money rather than in steps. At
     * `softRatio` of either ceiling the run is asked to wrap up; at the ceiling
     * the next request is refused before it is sent, so nothing is lost
     * mid-flight. Unset = unlimited, which is what `--autonomous` means today.
     *
     * Both exist because neither alone is enough: a step cap is not comparable
     * across models (one answers in few long steps, another in many short
     * ones), and a USD cap is a no-op on a local model that costs nothing.
     */
    runTokens?: number;
    runUsd?: number;
    /** Fraction of a ceiling that triggers the wrap-up request (default 0.75). */
    softRatio?: number;
  };
  /** Autonomous goal-loop defaults (/goal). */
  autonomy: {
    /** "once" stops when the goal is done; "eternal" runs until stopped. */
    mode: AutonomyMode;
    /** Safety step cap for "once" mode. */
    maxSteps?: number;
    /** Phased mode: cap on the number of sequential phases (default 8). */
    maxPhases?: number;
    /** Phased mode: max sub-agents per parallel phase (default = fleet.concurrency). */
    phasedFanout?: number;
    /**
     * When the step cap is hit, extend it by `extendBy` — but only if the run
     * made progress (tool calls or verification attempts) since the last
     * extension. A run that spins without touching anything stops with a clear
     * reason instead. Off by default: the hard cap stays the behavior unless
     * you opt into unattended runs.
     */
    autoExtend?: boolean;
    /** Steps granted per progress-gated extension (default 25). */
    extendBy?: number;
    /** Eternal mode: abort a single step after this long (default 5 min). */
    stepTimeoutMs?: number;
    /**
     * Eternal mode: pause between steps (default 1000ms; 0 = none). A real
     * model paces the loop naturally; a fast, erroring, or looping provider
     * does not, and without this gap an eternal run spins at hundreds of
     * steps a minute.
     */
    cycleGapMs?: number;
    /**
     * Eternal mode: consecutive failed/idle/looping steps before the engine
     * pivots — asks the model for one different concrete task instead of
     * re-running the same directive (default 3). Rotation, not a stop.
     */
    failureBudget?: number;
    /**
     * Eternal mode's relationship to completion claims. "never" (default) keeps
     * the historical semantics: claims are ignored and the loop runs until
     * stopped. "claim" routes a completion claim through the same verification
     * gate as every other mode — accepted ends the run, rejected queues the
     * mustFix note and keeps looping (persist is inherent; there is no attempt
     * cap in eternal).
     */
    eternalCompletion?: "never" | "claim";
    /** @deprecated Superseded by the top-level `verify` block. Still honored. */
    verify?: boolean;
    /** @deprecated Superseded by `verify.model`. Still honored. */
    verifyModel?: string;
  };
  /**
   * Loop/stuck detector: fingerprints each iteration (tool names + first call's
   * arguments) and watches a sliding window of individual calls, so both
   * verbatim repetition and A-B-A-B alternation are caught. At `steerAfter`
   * repeats a corrective note is injected; at `cutAfter` the turn is cut. The
   * autonomy engine reacts to a cut by pivoting (eternal) or stopping (bounded
   * modes). Applies to the main agent and sub-agents alike.
   */
  loopDetect: {
    /** Master switch (default true). */
    enabled?: boolean;
    /** Identical repeats before a corrective steer note (default 3). */
    steerAfter?: number;
    /** Identical repeats before the turn is cut (default 5). */
    cutAfter?: number;
    /** Sliding-window size for the per-call repeat check (default 10). */
    window?: number;
  };
  /**
   * Result verification: a deterministic command gate, with an LLM judge behind it.
   *
   * On by default, and safe to be: the deterministic half costs nothing and is a
   * no-op unless a task or phase explicitly declares `verify: <cmd>`, while the
   * judge half runs only at completion boundaries and FAILS OPEN — a dead key, an
   * unreachable host, or a model too small to emit a tool call all accept the
   * claim. Turning it on can therefore only catch a bad result, never break a
   * working setup.
   */
  verify: {
    /** Master switch for the whole layer. */
    enabled?: boolean;
    /** Run the LLM judge behind the deterministic gate. */
    judge?: boolean;
    /** Model for the judge (default: the session model). */
    model?: string;
    /** Judge autonomy-step cap. */
    maxSteps?: number;
    /** Judge tool round-trips per step — with maxSteps, this bounds one verdict. */
    maxIterations?: number;
    /** Kill a declared verification command after this long. */
    commandTimeoutMs?: number;
    /** Verification attempts per unit of work before giving up. */
    attempts?: number;
    /**
     * Command the deterministic gate falls back to when the work declares no
     * `verify: <cmd>` line of its own — e.g. `"pnpm -r typecheck && pnpm -r test"`.
     *
     * Unset (the default), an undeclared unit is gated by the judge alone, which
     * only READS: nothing ever runs the suite, so "the tests pass" is an opinion.
     * This is the switch that makes it a fact. It comes from this file and never
     * from model output — a declared `verify:` line still wins, and a model can
     * only ever narrow the gate to its own task, not replace yours.
     *
     * It runs at every completion boundary, so a whole-repo suite here is paid
     * once per phase/round, not once per run.
     */
    command?: string;
    /**
     * Keep working after `attempts` rejections instead of stopping the run.
     *
     * The rejection's `mustFix` items are already queued as the next step's steer
     * note; this only removes the give-up. The mode's own bound (`autonomy.maxSteps`,
     * `maxPhases`, `team.maxRounds`) stays the ceiling, so the run is still finite.
     * Off by default: a run that cannot satisfy the reviewer twice usually needs a
     * human, not another lap.
     */
    persist?: boolean;
  };
  /** External MCP (Model Context Protocol) servers to connect over stdio. */
  mcpServers: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>;
  /** Per-plugin trust level (untrusted by default — tools forced to ask, execute blocked). */
  plugins: Record<string, { trust: TrustTier }>;
  /** Agent teams (/team): leader assembles specialist members and assigns work per round. */
  team: {
    /** Max members / concurrent assignments per round (default 4). */
    fanout?: number;
    /** Cap on assignment rounds (default 6). */
    maxRounds?: number;
    /**
     * Member filesystem isolation. "auto" (default) = write-capable members get
     * their own git worktree, read-only members share the cwd; "worktree"/"none"
     * force one behavior for everyone.
     */
    isolation?: "auto" | "worktree" | "none";
    /** "apply" (default) = auto-apply member patches to the main tree; "surface" = report only. */
    mergeStrategy?: "surface" | "apply";
    /** Offer to run large-looking prompts as a team (y/N confirm; default true). */
    suggest?: boolean;
    /**
     * Shared blackboard: members read each other's results and can address
     * teammates with the `message` tool (default true). false keeps the pure
     * star topology where all coordination goes through the leader.
     */
    blackboard?: boolean;
    /**
     * Per-member private memory: members carry their own notes (`memo` tool) and a
     * recap of their last rounds across rounds (default true). false makes every
     * member start each round with no memory of its own earlier work.
     */
    memory?: boolean;
  };
  /** Parallel sub-agent fan-out (spawn_parallel, parallel/phased autonomy, /sdd). */
  fleet: {
    concurrency?: number;
    /** "none" (default) = shared cwd; "worktree" = isolate each worker in its own git worktree. */
    isolation?: "none" | "worktree";
    /** How concurrent worktree branches are reconciled. "surface" (default) only reports diffs. */
    mergeStrategy?: "surface" | "apply";
    /**
     * Sub-agents never block on a permission prompt: they get their own
     * yolo-derived policy where escalations fail closed (deny with a reason)
     * instead of waiting on a human. Explicit per-tool `deny` overrides and the
     * arbiter's critical block still win — they sit above yolo in the ladder.
     * Off by default; also implied by `--autonomous`. Without it, sub-agents in
     * an `ask` session still route prompts to the user as before.
     */
    autoApprove?: boolean;
  };
  /** Brain Arbiter: risk-gate tool calls (deny critical, escalate high). */
  arbiter: {
    enabled: boolean;
    /**
     * Optional gatekeeper model (OpenAI Agents SDK "cheap model guards the
     * expensive one" pattern): screens execute-category tool calls BEFORE the
     * permission chain and can only BLOCK, never approve — the regex RiskArbiter
     * and the permission mode still run after it. Unset = no model gate.
     */
    model?: string;
  };
  /** models.dev catalog: enrich model listing + native-tool detection from authoritative data. */
  catalog?: {
    /** Fetch/consult the catalog (default true). */
    enabled?: boolean;
    /** Cache freshness before a background refresh (default 24h). */
    maxAgeHours?: number;
  };
  /** Loopback status server for the Arterm desktop app (docs/desktop-integration.md). */
  statusServer?: {
    /**
     * true = always (headless included), false = never, "auto" = every interactive
     * session in any terminal, headless only inside the Arterm terminal (default).
     */
    enabled?: boolean | "auto";
    /** Listen port; 0 = OS-assigned ephemeral (default — collision-free across sessions). */
    port?: number;
  };
  /**
   * Re-prompt for tools tagged `riskTier: "destructive"` even in auto/yolo modes.
   * Off by default; enable with `--confirm-destructive`.
   */
  confirmDestructive: boolean;
  /** Spec-Driven Development (/sdd): interview → spec → task-DAG → parallel execution. */
  sdd: {
    /** Max clarifying questions in the interview step (default 4). */
    maxQuestions?: number;
    /** Cap on generated tasks in the graph (default 12). */
    maxTasks?: number;
    /**
     * Character budget for the finished dependencies' output handed to a
     * dependent task, split evenly among them (default 12000). 0 sends the
     * task's title and description only, as before.
     */
    handoffChars?: number;
    /**
     * Character budget for the spec document quoted into every task's prompt
     * (default 6000). 0 dispatches tasks without the spec they came from.
     */
    specChars?: number;
  };
  /** Persistent, project-scoped memory (claude-mem-style capture/digest/recall). */
  memory: {
    /** "jsonl" = persist learnings per project (default); "off" = disabled. */
    mode: "off" | "jsonl";
    /** How many recent learnings to inject into the system prompt (default 12). */
    maxInject?: number;
    /** Digest the session's activity into learnings at session end (default true). */
    autoDigest?: boolean;
    /** Also digest mid-session after every N captured observations (default 20; 0 = off). */
    digestEvery?: number;
    /**
     * Which memory engine to run. "cmem" (default) = the richer `@arterm/memory`
     * engine (typed observations, progressive-disclosure legend, dedup by
     * content hash, semantic search); "legacy" = the older flat-learning
     * pipeline. Mutually exclusive per session, so recall/tools are never
     * doubled. cmem became the default once its whole loop was verified
     * end-to-end — capture → digest → store → next-session recall — because a
     * memory engine nobody enables is a memory engine nobody has.
     */
    engine?: "legacy" | "cmem";
    /** cmem only: use Ollama embeddings for semantic search (default true; false = offline hash). */
    embeddings?: boolean;
    /** cmem only: Ollama embedding model (default "nomic-embed-text"). */
    embedModel?: string;
    /** cmem only: how many observations to list in the session-start legend (default 12). */
    legendLimit?: number;
    /**
     * Model used for the digest/observation step only (falls back to the main
     * `model` when unset). Useful when the main model is a code model that can't
     * follow the observation format — point this at an instruct model instead.
     */
    summarizeModel?: string;
  };
  /** Terminal UI rendering options. */
  tui: {
    /**
     * Fullscreen mode (default): the TUI owns the whole window on the alternate
     * screen — the footer stays pinned to the bottom even while scrolling, and
     * the wheel scrolls the chat in-app (Claude Code's fullscreen renderer).
     * false = classic mode: the chat flows into the terminal's own scrollback.
     */
    fullscreen?: boolean;
    /**
     * Fullscreen only. false (default): no capture — plain left-drag selects
     * text natively (then Ctrl+Shift+C / right-click copies) and the wheel is
     * routed through the terminal's alternate-scroll arrows. true: capture the
     * mouse (SGR reporting) so the wheel scrolls the chat deterministically —
     * selection then needs Shift+drag (the terminal's capture bypass), like
     * Claude Code. Default flipped to false after real use: "select some text"
     * happens far more often than "the wheel direction felt off", and a copy
     * that needs a modifier or a slash command reads as broken. /mouse toggles
     * the live session either way.
     */
    mouse?: boolean;
  };
}

export const ARTERM_HOME = join(homedir(), ".arterm");
const CONFIG_PATH = join(ARTERM_HOME, "config.json");

export function defaultConfig(): ArtermConfig {
  return {
    provider: "ollama",
    model: "llama3.2",
    ollamaHost: process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434",
    openaiCompatHost: process.env.OPENAI_COMPAT_HOST ?? "http://localhost:1234/v1",
    openaiCompatHeaders: {},
    modelsDir: join(ARTERM_HOME, "models"),
    fallbackModels: [],
    temperature: 0.7,
    permissions: {},
    mode: "ask",
    // Persist transcripts by default so --resume/--continue work out of the box;
    // maxSessions bounds disk usage. Set `session.mode: "off"` to disable.
    session: { mode: "jsonl", maxSessions: 100 },
    context: { strategy: "window", window: 8192, compactAtPercent: 0.85, maxMessages: 40 },
    budget: { maxIterations: 50 },
    autonomy: {
      mode: "once",
      maxSteps: 25,
      maxPhases: 8,
      autoExtend: false,
      extendBy: 25,
      stepTimeoutMs: 300_000,
      failureBudget: 3,
      cycleGapMs: 1_000,
      eternalCompletion: "never",
    },
    loopDetect: { enabled: true, steerAfter: 3, cutAfter: 5, window: 10 },
    verify: {
      enabled: true,
      judge: true,
      maxSteps: 2,
      maxIterations: 10,
      commandTimeoutMs: 180_000,
      attempts: 2,
    },
    mcpServers: {},
    plugins: {},
    team: {
      fanout: 4,
      maxRounds: 6,
      isolation: "auto",
      mergeStrategy: "apply",
      suggest: true,
      blackboard: true,
      memory: true,
    },
    tui: { fullscreen: true, mouse: false },
    fleet: { concurrency: 4, isolation: "none", mergeStrategy: "surface", autoApprove: false },
    arbiter: { enabled: true },
    catalog: { enabled: true, maxAgeHours: 24 },
    statusServer: { enabled: "auto", port: 0 },
    confirmDestructive: false,
    sdd: { maxQuestions: 4, maxTasks: 12, handoffChars: 12_000, specChars: 6_000 },
    memory: { mode: "jsonl", maxInject: 12, autoDigest: true, digestEvery: 20, engine: "cmem" },
  };
}

/**
 * Schema for the user-editable config file. Every field is optional (the file
 * is a partial overlay on `defaultConfig()`); unknown keys pass through so an
 * older binary doesn't strip a newer config. Enum/type mismatches are reported
 * per-field and that field falls back to its default instead of misbehaving
 * deep inside the session.
 */
const configFileSchema = z
  .object({
    provider: z.string(),
    model: z.string(),
    ollamaHost: z.string(),
    openaiCompatHost: z.string(),
    openaiCompatHeaders: z.record(z.string()),
    modelsDir: z.string(),
    fallbackModels: z.array(z.object({ provider: z.string().optional(), model: z.string() })),
    temperature: z.number().min(0).max(2),
    permissions: z.record(z.enum(["allow", "ask", "deny"])),
    mode: z.enum(["ask", "auto", "plan", "yolo"]),
    session: z
      .object({
        mode: z.enum(["off", "jsonl"]),
        maxSessions: z.number().int().positive().optional(),
        maxAgeDays: z.number().positive().optional(),
      })
      .partial(),
    context: z
      .object({
        strategy: z.enum(["none", "window", "summary"]),
        window: z.number().int().positive().optional(),
        compactAtPercent: z.number().min(0).max(1).optional(),
        maxMessages: z.number().int().positive().optional(),
        clearToolResults: z.boolean().optional(),
        clearAtPercent: z.number().min(0).max(1).optional(),
        keepRecentToolResults: z.number().int().nonnegative().optional(),
      })
      .partial(),
    budget: z
      .object({
        turnTokens: z.number().int().positive().optional(),
        maxIterations: z.number().int().positive().optional(),
        runTokens: z.number().int().positive().optional(),
        runUsd: z.number().positive().optional(),
        softRatio: z.number().gt(0).lt(1).optional(),
      })
      .partial(),
    autonomy: z
      .object({
        mode: z.enum(["once", "eternal", "parallel", "phased", "team"]),
        maxSteps: z.number().int().positive().optional(),
        maxPhases: z.number().int().positive().optional(),
        phasedFanout: z.number().int().positive().optional(),
        autoExtend: z.boolean().optional(),
        extendBy: z.number().int().positive().optional(),
        stepTimeoutMs: z.number().int().positive().optional(),
        failureBudget: z.number().int().positive().optional(),
        cycleGapMs: z.number().int().nonnegative().optional(),
        eternalCompletion: z.enum(["never", "claim"]).optional(),
        verify: z.boolean().optional(),
        verifyModel: z.string().optional(),
      })
      .partial(),
    loopDetect: z
      .object({
        enabled: z.boolean().optional(),
        steerAfter: z.number().int().positive().optional(),
        cutAfter: z.number().int().positive().optional(),
        window: z.number().int().positive().optional(),
      })
      .partial(),
    verify: z
      .object({
        enabled: z.boolean(),
        judge: z.boolean(),
        model: z.string(),
        maxSteps: z.number().int().positive(),
        maxIterations: z.number().int().positive(),
        commandTimeoutMs: z.number().int().positive(),
        attempts: z.number().int().positive(),
        command: z.string(),
        persist: z.boolean(),
      })
      .partial(),
    mcpServers: z.record(
      z.object({
        command: z.string(),
        args: z.array(z.string()).optional(),
        env: z.record(z.string()).optional(),
      }),
    ),
    plugins: z.record(z.object({ trust: z.enum(["untrusted", "trusted"]) })),
    team: z
      .object({
        fanout: z.number().int().positive().optional(),
        maxRounds: z.number().int().positive().optional(),
        isolation: z.enum(["auto", "worktree", "none"]).optional(),
        mergeStrategy: z.enum(["surface", "apply"]).optional(),
        suggest: z.boolean().optional(),
        blackboard: z.boolean().optional(),
        memory: z.boolean().optional(),
      })
      .partial(),
    tui: z.object({ fullscreen: z.boolean().optional(), mouse: z.boolean().optional() }).partial(),
    fleet: z
      .object({
        concurrency: z.number().int().positive().optional(),
        isolation: z.enum(["none", "worktree"]).optional(),
        mergeStrategy: z.enum(["surface", "apply"]).optional(),
        autoApprove: z.boolean().optional(),
      })
      .partial(),
    arbiter: z
      .object({
        enabled: z.boolean().optional(),
        model: z.string().optional(),
      })
      .partial(),
    catalog: z
      .object({
        enabled: z.boolean().optional(),
        maxAgeHours: z.number().positive().optional(),
      })
      .partial(),
    statusServer: z
      .object({
        enabled: z.union([z.boolean(), z.literal("auto")]).optional(),
        port: z.number().int().min(0).max(65535).optional(),
      })
      .partial(),
    confirmDestructive: z.boolean(),
    sdd: z
      .object({
        maxQuestions: z.number().int().positive().optional(),
        maxTasks: z.number().int().positive().optional(),
        handoffChars: z.number().int().nonnegative().optional(),
        specChars: z.number().int().nonnegative().optional(),
      })
      .partial(),
    memory: z
      .object({
        mode: z.enum(["off", "jsonl"]),
        maxInject: z.number().int().nonnegative().optional(),
        autoDigest: z.boolean().optional(),
        digestEvery: z.number().int().nonnegative().optional(),
        engine: z.enum(["legacy", "cmem"]).optional(),
        embeddings: z.boolean().optional(),
        embedModel: z.string().optional(),
        legendLimit: z.number().int().positive().optional(),
        summarizeModel: z.string().optional(),
      })
      .partial(),
  })
  .partial()
  .passthrough();

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Recursively merge a partial user config over the defaults. Nested objects
 * merge key-by-key (so `session: { mode: "off" }` keeps the block's other
 * defaults); scalars and arrays replace.
 */
export function mergeConfig<T>(defaults: T, overlay: unknown): T {
  if (!isPlainObject(defaults) || !isPlainObject(overlay)) {
    return (overlay === undefined ? defaults : overlay) as T;
  }
  const out: Record<string, unknown> = { ...defaults };
  for (const [key, value] of Object.entries(overlay)) {
    if (value === undefined) continue;
    out[key] =
      isPlainObject(out[key]) && isPlainObject(value) ? mergeConfig(out[key], value) : value;
  }
  return out as T;
}

/** Remove the value at a (possibly nested) issue path so the default applies. */
function deleteAtPath(obj: Record<string, unknown>, path: readonly (string | number)[]): void {
  if (path.length === 0) return;
  let cursor: unknown = obj;
  for (const seg of path.slice(0, -1)) {
    if (!isPlainObject(cursor)) return;
    cursor = cursor[String(seg)];
  }
  if (isPlainObject(cursor)) delete cursor[String(path[path.length - 1])];
}

/**
 * Validate a parsed config-file object. Invalid fields are dropped (falling
 * back to defaults) and reported via `warn`; valid fields survive untouched.
 */
export function validateConfigFile(
  parsed: unknown,
  warn: (msg: string) => void = (msg) => console.warn(msg),
): Partial<ArtermConfig> {
  if (!isPlainObject(parsed)) {
    warn(`⚠ ${CONFIG_PATH} must contain a JSON object; using defaults.`);
    return {};
  }
  const result = configFileSchema.safeParse(parsed);
  if (result.success) return result.data as Partial<ArtermConfig>;

  const cleaned = structuredClone(parsed);
  for (const issue of result.error.issues) {
    warn(`⚠ ${CONFIG_PATH}: ignoring invalid "${issue.path.join(".")}" (${issue.message}).`);
    deleteAtPath(cleaned, issue.path);
  }
  const second = configFileSchema.safeParse(cleaned);
  if (second.success) return second.data as Partial<ArtermConfig>;
  warn(`⚠ ${CONFIG_PATH} could not be validated; using defaults.`);
  return {};
}

export async function loadConfig(): Promise<ArtermConfig> {
  let raw: string;
  try {
    raw = await fs.readFile(CONFIG_PATH, "utf8");
  } catch {
    // No config file yet (first run): fall back to defaults silently.
    return defaultConfig();
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return mergeConfig(defaultConfig(), validateConfigFile(parsed));
  } catch (err) {
    // The file exists but is unreadable JSON — surface it so the user's edits
    // aren't silently discarded, then carry on with defaults rather than crash.
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`⚠ ${CONFIG_PATH} is invalid (${reason}); using defaults.`);
    return defaultConfig();
  }
}

export async function saveConfig(config: ArtermConfig): Promise<void> {
  await fs.mkdir(dirname(CONFIG_PATH), { recursive: true });
  await fs.writeFile(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}
