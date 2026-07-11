import type { ArtermConfig, ChatProvider } from "@arterm/core";
import { Keystore } from "@arterm/core";
import { AnthropicProvider } from "./anthropic.js";
import { LlamaCppProvider } from "./llamacpp.js";
import {
  ANTHROPIC_OAUTH,
  type OAuthConfig,
  type OAuthTokens,
  refreshTokens,
  tokensExpired,
} from "./oauth.js";
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
  /** True when the provider needs a custom base URL (the login overlay prompts for one). */
  needsHost?: boolean;
  /** True when the provider also supports subscription login (OAuth, via `arterm login`). */
  supportsOAuth?: boolean;
}

/** Providers that support subscription (OAuth) login, mapped to their endpoints. */
const OAUTH_CONFIGS: Record<string, OAuthConfig> = {
  anthropic: ANTHROPIC_OAUTH,
};

/** Provider ids that support subscription (OAuth) login. */
export const oauthProviderIds: readonly string[] = Object.keys(OAUTH_CONFIGS);

/** Keystore entry name holding a provider's encrypted OAuth token blob. */
function oauthKey(id: string): string {
  return `${id}-oauth`;
}

/**
 * Every backend offered in the login flow — the single source of truth for
 * provider ids the UI presents. Local backends need no key; hosted ones do.
 */
export const providerCatalog: readonly ProviderDescriptor[] = [
  { id: "ollama", label: "Ollama — local server", needsKey: false },
  { id: "llamacpp", label: "llama.cpp — local .gguf", needsKey: false },
  {
    id: "openai-compat",
    label: "OpenAI-compatible — custom host",
    needsKey: false,
    needsHost: true,
  },
  { id: "anthropic", label: "Anthropic — Claude", needsKey: true, supportsOAuth: true },
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
 * Env var consulted for each key-based provider's API key (keystore name → env var).
 * Anthropic plus every hosted OpenAI-compatible preset; the single map a key
 * preflight needs to know which env var backs a given provider id.
 */
const KEY_ENV_VARS: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  ...Object.fromEntries(Object.entries(OPENAI_COMPAT_PRESETS).map(([id, p]) => [id, p.envVar])),
};

/**
 * True when a key-based provider has an API key configured (encrypted keystore or
 * env var). Returns false for local providers (which need no key) and unknown ids.
 * Used by the CLI's startup preflight to warn before the first turn fails.
 */
export function hasApiKey(providerId: string): boolean {
  const envVar = KEY_ENV_VARS[providerId];
  if (!envVar) return false;
  return Boolean(apiKeyFor(providerId, envVar));
}

/**
 * True when a provider has *any* usable credential — an API key (keystore/env)
 * or a stored subscription (OAuth) session. The startup preflight uses this so a
 * user who ran `arterm login` isn't warned about a missing key.
 */
export function hasCredentials(providerId: string): boolean {
  return hasApiKey(providerId) || getOAuthTokens(providerId) !== undefined;
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

/** The OAuth endpoint config for a provider id, or undefined if it has none. */
export function oauthConfigFor(id: string): OAuthConfig | undefined {
  return OAUTH_CONFIGS[id];
}

/** Read a provider's stored OAuth tokens (decrypted), or undefined if absent/corrupt. */
export function getOAuthTokens(id: string): OAuthTokens | undefined {
  try {
    cachedKeystore ??= Keystore.open();
    const raw = cachedKeystore.get(oauthKey(id));
    if (!raw) return undefined;
    const t = JSON.parse(raw) as OAuthTokens;
    if (!t.accessToken || !t.refreshToken) return undefined;
    return t;
  } catch {
    return undefined;
  }
}

/** Persist a provider's OAuth tokens (encrypted), keeping the cache fresh. */
export function setOAuthTokens(id: string, tokens: OAuthTokens): void {
  cachedKeystore ??= Keystore.open();
  cachedKeystore.set(oauthKey(id), JSON.stringify(tokens));
}

/** Forget a provider's OAuth tokens; returns whether any existed. */
export function removeOAuthTokens(id: string): boolean {
  try {
    cachedKeystore ??= Keystore.open();
    return cachedKeystore.remove(oauthKey(id));
  } catch {
    return false;
  }
}

/** Provider ids the user has a stored OAuth session for (shown as signed-in). */
export function oauthSignedIn(): string[] {
  return oauthProviderIds.filter((id) => getOAuthTokens(id) !== undefined);
}

/**
 * Build a per-request access-token resolver for an OAuth provider: returns the
 * stored access token, transparently refreshing (and re-persisting) it when it's
 * within the expiry skew. Returns undefined when the user isn't signed in.
 */
function accessTokenResolver(id: string): (() => Promise<string>) | undefined {
  const config = OAUTH_CONFIGS[id];
  if (!config) return undefined;
  if (!getOAuthTokens(id)) return undefined;
  return async () => {
    const tokens = getOAuthTokens(id);
    if (!tokens) {
      throw new Error(`Not signed in to ${id}. Run \`arterm login ${id}\`.`);
    }
    if (!tokensExpired(tokens)) return tokens.accessToken;
    try {
      const refreshed = await refreshTokens(config, tokens.refreshToken);
      setOAuthTokens(id, refreshed);
      return refreshed.accessToken;
    } catch (err) {
      // A dead refresh token (expired, revoked, or rotated by another client)
      // can never recover by retrying — drop it so the UI reports a clean
      // signed-out state, and say exactly how to get back in.
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("invalid_grant")) {
        removeOAuthTokens(id);
        throw new Error(
          `${id} session expired — sign in again with \`arterm login ${id}\` (or /login in the TUI).`,
        );
      }
      throw err;
    }
  };
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
        headers: config.openaiCompatHeaders,
      });
    case "anthropic": {
      // Prefer an explicit subscription login (OAuth) when present; otherwise API key.
      const getAccessToken = accessTokenResolver("anthropic");
      if (getAccessToken) return new AnthropicProvider({ getAccessToken });
      return new AnthropicProvider({ apiKey: apiKeyFor("anthropic", "ANTHROPIC_API_KEY") });
    }
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
      headers: config.openaiCompatHeaders,
    }),
  ];

  // Anthropic's model list is static, so gate it on credentials — otherwise it
  // would surface in `arterm models` / the picker even when the user can't use it.
  // A subscription login (OAuth) counts just like an API key.
  const anthropicOAuth = accessTokenResolver("anthropic");
  const anthropicKey = apiKeyFor("anthropic", "ANTHROPIC_API_KEY");
  if (anthropicOAuth) providers.push(new AnthropicProvider({ getAccessToken: anthropicOAuth }));
  else if (anthropicKey) providers.push(new AnthropicProvider({ apiKey: anthropicKey }));

  for (const [id, preset] of Object.entries(OPENAI_COMPAT_PRESETS)) {
    const apiKey = apiKeyFor(id, preset.envVar);
    if (apiKey) providers.push(new OpenAICompatProvider({ id, baseUrl: preset.baseUrl, apiKey }));
  }

  return providers;
}
