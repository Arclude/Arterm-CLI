import { createHash, randomBytes } from "node:crypto";

/**
 * OAuth 2.0 (PKCE) login for provider *subscriptions* — e.g. signing in with a
 * Claude Pro/Max account instead of pasting a console API key. The flow is the
 * public-client Authorization-Code + PKCE grant Claude Code itself uses:
 *
 *   1. generate a code verifier/challenge (`createPkce`) and a `state` nonce,
 *   2. open the authorize URL (`buildAuthorizeUrl`) in a browser,
 *   3. the user approves and is handed a `code#state` string to paste back,
 *   4. exchange it for tokens (`exchangeCode`), refreshing later (`refreshTokens`).
 *
 * The network calls take an injectable `fetch` so the deterministic parts (PKCE,
 * URL building, body shaping, expiry math) are unit-testable offline. The endpoint
 * constants live in `ANTHROPIC_OAUTH` — these are the documented Claude public
 * client values; nothing here is provider-secret.
 */

/** Persisted token set for a logged-in subscription. */
export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  /** Epoch milliseconds at which `accessToken` stops being valid. */
  expiresAt: number;
}

/** The verifier/challenge pair for one PKCE login attempt. */
export interface Pkce {
  /** Secret kept by the client; sent only on the token exchange. */
  verifier: string;
  /** SHA-256(verifier), base64url — sent on the authorize request. */
  challenge: string;
}

/** Static configuration for an OAuth-capable provider. */
export interface OAuthConfig {
  clientId: string;
  authorizeUrl: string;
  tokenUrl: string;
  redirectUri: string;
  scopes: string[];
}

/**
 * Anthropic / Claude subscription OAuth (public client — the same values the
 * Claude Code CLI uses; safe to ship). `org:create_api_key` lets the token mint
 * a scoped key, `user:inference` authorizes Messages-API calls on the plan.
 */
export const ANTHROPIC_OAUTH: OAuthConfig = {
  clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  authorizeUrl: "https://claude.ai/oauth/authorize",
  tokenUrl: "https://console.anthropic.com/v1/oauth/token",
  redirectUri: "https://console.anthropic.com/oauth/code/callback",
  scopes: ["org:create_api_key", "user:profile", "user:inference"],
};

/** Base64url-encode a buffer (no padding) — the encoding PKCE/JWT expect. */
function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Generate a fresh PKCE verifier + S256 challenge. */
export function createPkce(): Pkce {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

/** A random, URL-safe `state` nonce binding the authorize request to the callback. */
export function createState(): string {
  return base64url(randomBytes(24));
}

/** Build the browser authorize URL for a PKCE login. */
export function buildAuthorizeUrl(
  config: OAuthConfig,
  params: { challenge: string; state: string },
): string {
  const url = new URL(config.authorizeUrl);
  url.searchParams.set("code", "true");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("scope", config.scopes.join(" "));
  url.searchParams.set("code_challenge", params.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", params.state);
  return url.toString();
}

/**
 * Parse the value the user pastes back from the callback page. Claude hands out a
 * `code#state` string, but tolerate a bare code or a full redirect URL too.
 */
export function parseCallbackCode(input: string): { code: string; state?: string } {
  const trimmed = input.trim();

  // A full redirect URL: pull `code`/`state` out of the query string.
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      const code = url.searchParams.get("code") ?? "";
      const state = url.searchParams.get("state") ?? undefined;
      return { code, state };
    } catch {
      // fall through to the `code#state` handling
    }
  }

  const hash = trimmed.indexOf("#");
  if (hash >= 0) {
    return { code: trimmed.slice(0, hash), state: trimmed.slice(hash + 1) || undefined };
  }
  return { code: trimmed };
}

type FetchLike = typeof fetch;

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

/** POST to the token endpoint and normalize the response into `OAuthTokens`. */
async function postToken(
  config: OAuthConfig,
  body: Record<string, string>,
  deps: { fetch?: FetchLike; now?: () => number } = {},
): Promise<OAuthTokens> {
  const fetchImpl = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const res = await fetchImpl(config.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`OAuth token request failed (${res.status})${detail ? `: ${detail}` : ""}`);
  }
  const json = (await res.json()) as TokenResponse;
  if (!json.access_token || !json.refresh_token) {
    throw new Error("OAuth token response missing access_token/refresh_token");
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: now() + (json.expires_in ?? 0) * 1000,
  };
}

/** Exchange an authorization code (+ PKCE verifier) for tokens. */
export function exchangeCode(
  config: OAuthConfig,
  args: { code: string; verifier: string; state?: string },
  deps?: { fetch?: FetchLike; now?: () => number },
): Promise<OAuthTokens> {
  return postToken(
    config,
    {
      grant_type: "authorization_code",
      code: args.code,
      ...(args.state ? { state: args.state } : {}),
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      code_verifier: args.verifier,
    },
    deps,
  );
}

/** Trade a refresh token for a fresh access/refresh pair. */
export function refreshTokens(
  config: OAuthConfig,
  refreshToken: string,
  deps?: { fetch?: FetchLike; now?: () => number },
): Promise<OAuthTokens> {
  return postToken(
    config,
    { grant_type: "refresh_token", refresh_token: refreshToken, client_id: config.clientId },
    deps,
  );
}

/**
 * True when the access token is at (or within `skewMs` of) expiry and should be
 * refreshed before use. The 60s default skew avoids racing the clock mid-request.
 */
export function tokensExpired(tokens: OAuthTokens, nowMs = Date.now(), skewMs = 60_000): boolean {
  return nowMs >= tokens.expiresAt - skewMs;
}
