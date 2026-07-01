import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
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
  /** Directory holding .gguf files for direct loading. */
  modelsDir: string;
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
  };
  /** External MCP (Model Context Protocol) servers to connect over stdio. */
  mcpServers: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>;
  /** Per-plugin trust level (untrusted by default — tools forced to ask, execute blocked). */
  plugins: Record<string, { trust: TrustTier }>;
  /**
   * Parallel sub-agent fan-out (spawn_parallel, parallel/phased autonomy, /sdd).
   * NOTE: `loadConfig` shallow-merges, so a user-supplied `fleet` object replaces
   * this whole block — re-state every field you want to keep.
   */
  fleet: {
    concurrency?: number;
    /** "none" (default) = shared cwd; "worktree" = isolate each worker in its own git worktree. */
    isolation?: "none" | "worktree";
    /** How concurrent worktree branches are reconciled. "surface" (default) only reports diffs. */
    mergeStrategy?: "surface" | "apply";
  };
  /** Brain Arbiter: risk-gate tool calls (deny critical, escalate high). */
  arbiter: { enabled: boolean };
  /** models.dev catalog: enrich model listing + native-tool detection from authoritative data. */
  catalog?: {
    /** Fetch/consult the catalog (default true). */
    enabled?: boolean;
    /** Cache freshness before a background refresh (default 24h). */
    maxAgeHours?: number;
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
     * Which memory engine to run. "legacy" (default) = the built-in flat-learning
     * pipeline; "cmem" = the richer `@arterm/memory` engine (typed observations,
     * progressive-disclosure legend, SQLite/FTS5, semantic search). Mutually
     * exclusive per session, so recall/tools are never doubled.
     */
    engine?: "legacy" | "cmem";
    /** cmem only: use Ollama embeddings for semantic search (default true; false = offline hash). */
    embeddings?: boolean;
    /** cmem only: Ollama embedding model (default "nomic-embed-text"). */
    embedModel?: string;
    /** cmem only: how many observations to list in the session-start legend (default 12). */
    legendLimit?: number;
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
    modelsDir: join(ARTERM_HOME, "models"),
    temperature: 0.7,
    permissions: {},
    mode: "ask",
    session: { mode: "off" },
    context: { strategy: "window", window: 8192, compactAtPercent: 0.85, maxMessages: 40 },
    autonomy: { mode: "once", maxSteps: 25, maxPhases: 8 },
    mcpServers: {},
    plugins: {},
    fleet: { concurrency: 4, isolation: "none", mergeStrategy: "surface" },
    arbiter: { enabled: true },
    catalog: { enabled: true, maxAgeHours: 24 },
    confirmDestructive: false,
    sdd: { maxQuestions: 4, maxTasks: 12 },
    memory: { mode: "jsonl", maxInject: 12, autoDigest: true, digestEvery: 20, engine: "legacy" },
  };
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
    const parsed = JSON.parse(raw) as Partial<ArtermConfig>;
    return { ...defaultConfig(), ...parsed };
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
