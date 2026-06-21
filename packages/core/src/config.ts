import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { PermissionLevel } from "./types.js";

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
