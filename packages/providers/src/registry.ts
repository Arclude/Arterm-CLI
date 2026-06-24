import type { ArtermConfig, ChatProvider } from "@arterm/core";
import { Keystore } from "@arterm/core";
import { AnthropicProvider } from "./anthropic.js";
import { LlamaCppProvider } from "./llamacpp.js";
import { OllamaProvider } from "./ollama.js";
import { OpenAICompatProvider } from "./openai-compat.js";

/**
 * Hosted, OpenAI-compatible backends reachable with a Bearer API key.
 * Each provider id maps to its base URL and the env var consulted when no
 * encrypted keystore entry exists. Add a row here to support a new model
 * vendor — `arterm auth set <id>` then stores the key for it.
 */
const OPENAI_COMPAT_PRESETS: Record<string, { baseUrl: string; envVar: string }> = {
  openai: { baseUrl: "https://api.openai.com/v1", envVar: "OPENAI_API_KEY" },
  gemini: {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    envVar: "GEMINI_API_KEY",
  },
  xai: { baseUrl: "https://api.x.ai/v1", envVar: "XAI_API_KEY" },
  deepseek: { baseUrl: "https://api.deepseek.com/v1", envVar: "DEEPSEEK_API_KEY" },
  groq: { baseUrl: "https://api.groq.com/openai/v1", envVar: "GROQ_API_KEY" },
  openrouter: { baseUrl: "https://openrouter.ai/api/v1", envVar: "OPENROUTER_API_KEY" },
  mistral: { baseUrl: "https://api.mistral.ai/v1", envVar: "MISTRAL_API_KEY" },
};

/** Provider ids that map to a hosted OpenAI-compatible preset. */
export const hostedProviderIds: readonly string[] = Object.keys(OPENAI_COMPAT_PRESETS);

/** A selectable backend, as shown in the TUI login picker. */
export interface ProviderDescriptor {
  id: string;
  label: string;
  /** True when the provider authenticates with an API key (stored via Keystore). */
  needsKey: boolean;
}

/**
 * Every backend offered in the login flow — the single source of truth for
 * provider ids the UI presents. Local backends need no key; hosted ones do.
 */
export const providerCatalog: readonly ProviderDescriptor[] = [
  { id: "ollama", label: "Ollama — local server", needsKey: false },
  { id: "llamacpp", label: "llama.cpp — local .gguf", needsKey: false },
  { id: "openai-compat", label: "OpenAI-compatible — custom host", needsKey: false },
  { id: "anthropic", label: "Anthropic — Claude", needsKey: true },
  { id: "openai", label: "OpenAI — ChatGPT", needsKey: true },
  { id: "gemini", label: "Google — Gemini", needsKey: true },
  { id: "xai", label: "xAI — Grok", needsKey: true },
  { id: "deepseek", label: "DeepSeek", needsKey: true },
  { id: "groq", label: "Groq", needsKey: true },
  { id: "openrouter", label: "OpenRouter", needsKey: true },
  { id: "mistral", label: "Mistral", needsKey: true },
];

let cachedKeystore: Keystore | undefined;

/** Resolve an API key: encrypted keystore entry first, then the env var. */
function apiKeyFor(name: string, envVar: string): string | undefined {
  try {
    cachedKeystore ??= Keystore.open();
    return cachedKeystore.get(name) ?? process.env[envVar];
  } catch {
    return process.env[envVar];
  }
}

/**
 * Persist an API key for a provider (encrypted, AES-256-GCM), keeping the
 * in-process keystore cache fresh so a subsequent `createProvider` sees it
 * without a reload — used by the TUI login flow.
 */
export function setApiKey(name: string, secret: string): void {
  cachedKeystore ??= Keystore.open();
  cachedKeystore.set(name, secret);
}

/** Names of providers with a stored API key (the ones the user has logged into). */
export function storedKeyNames(): string[] {
  try {
    cachedKeystore ??= Keystore.open();
    return cachedKeystore.names();
  } catch {
    return [];
  }
}

/** Forget a provider's stored API key; returns whether one existed. */
export function removeApiKey(name: string): boolean {
  try {
    cachedKeystore ??= Keystore.open();
    return cachedKeystore.remove(name);
  } catch {
    return false;
  }
}

/** Builds the provider instance selected by config. */
export function createProvider(config: ArtermConfig, providerId?: string): ChatProvider {
  const id = providerId ?? config.provider;

  const preset = OPENAI_COMPAT_PRESETS[id];
  if (preset) {
    return new OpenAICompatProvider({
      id,
      baseUrl: preset.baseUrl,
      apiKey: apiKeyFor(id, preset.envVar),
    });
  }

  switch (id) {
    case "ollama":
      return new OllamaProvider({ host: config.ollamaHost });
    case "llamacpp":
      return new LlamaCppProvider({ modelsDir: config.modelsDir });
    case "openai-compat":
      return new OpenAICompatProvider({
        baseUrl: config.openaiCompatHost,
        apiKey: apiKeyFor("openai-compat", "OPENAI_API_KEY"),
      });
    case "anthropic":
      return new AnthropicProvider({ apiKey: apiKeyFor("anthropic", "ANTHROPIC_API_KEY") });
    default:
      throw new Error(`Unknown provider: ${id}`);
  }
}

/**
 * All providers, for listing models across backends. Local backends are always
 * included; hosted ones appear only when a key is configured (keystore or env),
 * so `arterm models` stays quiet about vendors the user never set up.
 */
export function allProviders(config: ArtermConfig): ChatProvider[] {
  const providers: ChatProvider[] = [
    new OllamaProvider({ host: config.ollamaHost }),
    new LlamaCppProvider({ modelsDir: config.modelsDir }),
    new OpenAICompatProvider({
      baseUrl: config.openaiCompatHost,
      apiKey: apiKeyFor("openai-compat", "OPENAI_API_KEY"),
    }),
  ];

  // Anthropic's model list is static, so gate it on a key — otherwise it would
  // surface in `arterm models` / the picker even when the user can't use it.
  const anthropicKey = apiKeyFor("anthropic", "ANTHROPIC_API_KEY");
  if (anthropicKey) providers.push(new AnthropicProvider({ apiKey: anthropicKey }));

  for (const [id, preset] of Object.entries(OPENAI_COMPAT_PRESETS)) {
    const apiKey = apiKeyFor(id, preset.envVar);
    if (apiKey) providers.push(new OpenAICompatProvider({ id, baseUrl: preset.baseUrl, apiKey }));
  }

  return providers;
}
