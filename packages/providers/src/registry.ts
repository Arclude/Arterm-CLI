import type { ArtermConfig, ChatProvider } from "@arterm/core";
import { Keystore } from "@arterm/core";
import { AnthropicProvider } from "./anthropic.js";
import { LlamaCppProvider } from "./llamacpp.js";
import { OllamaProvider } from "./ollama.js";
import { OpenAICompatProvider } from "./openai-compat.js";

/** OpenAI's hosted endpoint, for the convenience "openai" provider id. */
const OPENAI_BASE_URL = "https://api.openai.com/v1";

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

/** Builds the provider instance selected by config. */
export function createProvider(config: ArtermConfig, providerId?: string): ChatProvider {
  const id = providerId ?? config.provider;
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
    case "openai":
      return new OpenAICompatProvider({
        baseUrl: OPENAI_BASE_URL,
        apiKey: apiKeyFor("openai", "OPENAI_API_KEY"),
      });
    case "anthropic":
      return new AnthropicProvider({ apiKey: apiKeyFor("anthropic", "ANTHROPIC_API_KEY") });
    default:
      throw new Error(`Unknown provider: ${id}`);
  }
}

/** All providers, for listing models across backends. */
export function allProviders(config: ArtermConfig): ChatProvider[] {
  return [
    new OllamaProvider({ host: config.ollamaHost }),
    new LlamaCppProvider({ modelsDir: config.modelsDir }),
    new OpenAICompatProvider({
      baseUrl: config.openaiCompatHost,
      apiKey: apiKeyFor("openai-compat", "OPENAI_API_KEY"),
    }),
    new AnthropicProvider({ apiKey: apiKeyFor("anthropic", "ANTHROPIC_API_KEY") }),
  ];
}
