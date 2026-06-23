import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { PermissionMode } from "./permissions.js";
import type { AutonomyMode, PermissionLevel } from "./types.js";

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
    /** "none" = never compact; "window" = keep a recent slice; "summary" = (future). */
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
    autonomy: { mode: "once", maxSteps: 25 },
  };
}

export async function loadConfig(): Promise<ArtermConfig> {
  try {
    const raw = await fs.readFile(CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<ArtermConfig>;
    return { ...defaultConfig(), ...parsed };
  } catch {
    return defaultConfig();
  }
}

export async function saveConfig(config: ArtermConfig): Promise<void> {
  await fs.mkdir(dirname(CONFIG_PATH), { recursive: true });
  await fs.writeFile(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}
