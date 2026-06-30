import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  ANTHROPIC_OAUTH,
  buildAuthorizeUrl,
  createPkce,
  createState,
  exchangeCode,
  parseCallbackCode,
  refreshTokens,
  tokensExpired,
} from "./oauth.js";

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

describe("createPkce", () => {
  it("derives the challenge as base64url(SHA-256(verifier))", () => {
    const { verifier, challenge } = createPkce();
    expect(challenge).toBe(b64url(createHash("sha256").update(verifier).digest()));
  });

  it("is URL-safe and unpadded", () => {
    const { verifier, challenge } = createPkce();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("is unique per call", () => {
    expect(createPkce().verifier).not.toBe(createPkce().verifier);
    expect(createState()).not.toBe(createState());
  });
});

describe("buildAuthorizeUrl", () => {
  it("sets the PKCE + client params", () => {
    const url = new URL(buildAuthorizeUrl(ANTHROPIC_OAUTH, { challenge: "CH", state: "ST" }));
    expect(url.origin + url.pathname).toBe("https://claude.ai/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe(ANTHROPIC_OAUTH.clientId);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("code_challenge")).toBe("CH");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe("ST");
    expect(url.searchParams.get("scope")).toBe(ANTHROPIC_OAUTH.scopes.join(" "));
    expect(url.searchParams.get("redirect_uri")).toBe(ANTHROPIC_OAUTH.redirectUri);
  });
});

describe("parseCallbackCode", () => {
  it("splits a `code#state` paste", () => {
    expect(parseCallbackCode("  abc123#xyz \n")).toEqual({ code: "abc123", state: "xyz" });
  });

  it("accepts a bare code", () => {
    expect(parseCallbackCode("abc123")).toEqual({ code: "abc123" });
  });

  it("extracts code/state from a full redirect URL", () => {
    expect(parseCallbackCode("https://x.test/cb?code=abc&state=xyz")).toEqual({
      code: "abc",
      state: "xyz",
    });
  });
});

describe("exchangeCode", () => {
  it("posts the auth-code grant and normalizes the token response", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      Response.json({ access_token: "AT", refresh_token: "RT", expires_in: 3600 }),
    );
    const tokens = await exchangeCode(
      ANTHROPIC_OAUTH,
      { code: "C", verifier: "V", state: "S" },
      { fetch: fetchImpl as unknown as typeof fetch, now: () => 1_000 },
    );
    expect(tokens).toEqual({ accessToken: "AT", refreshToken: "RT", expiresAt: 1_000 + 3_600_000 });

    const [calledUrl, init] = fetchImpl.mock.calls[0]!;
    expect(calledUrl).toBe(ANTHROPIC_OAUTH.tokenUrl);
    const body = JSON.parse(init!.body as string);
    expect(body).toMatchObject({
      grant_type: "authorization_code",
      code: "C",
      state: "S",
      code_verifier: "V",
      client_id: ANTHROPIC_OAUTH.clientId,
      redirect_uri: ANTHROPIC_OAUTH.redirectUri,
    });
  });

  it("throws with the HTTP status on a non-2xx response", async () => {
    const fetchImpl = vi.fn(async () => new Response("bad code", { status: 400 }));
    await expect(
      exchangeCode(
        ANTHROPIC_OAUTH,
        { code: "C", verifier: "V" },
        { fetch: fetchImpl as unknown as typeof fetch },
      ),
    ).rejects.toThrow(/400.*bad code/);
  });

  it("throws when the response omits tokens", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ access_token: "AT" }));
    await expect(
      exchangeCode(
        ANTHROPIC_OAUTH,
        { code: "C", verifier: "V" },
        { fetch: fetchImpl as unknown as typeof fetch },
      ),
    ).rejects.toThrow(/missing/);
  });
});

describe("refreshTokens", () => {
  it("posts the refresh-token grant", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      Response.json({ access_token: "AT2", refresh_token: "RT2", expires_in: 100 }),
    );
    const tokens = await refreshTokens(ANTHROPIC_OAUTH, "RT", {
      fetch: fetchImpl as unknown as typeof fetch,
      now: () => 0,
    });
    expect(tokens).toEqual({ accessToken: "AT2", refreshToken: "RT2", expiresAt: 100_000 });
    const body = JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string);
    expect(body).toEqual({
      grant_type: "refresh_token",
      refresh_token: "RT",
      client_id: ANTHROPIC_OAUTH.clientId,
    });
  });
});

describe("tokensExpired", () => {
  const tokens = { accessToken: "a", refreshToken: "r", expiresAt: 1_000_000 };

  it("is false well before expiry", () => {
    expect(tokensExpired(tokens, 0, 60_000)).toBe(false);
  });

  it("is true once inside the skew window", () => {
    expect(tokensExpired(tokens, 940_001, 60_000)).toBe(true);
    expect(tokensExpired(tokens, 1_000_001, 0)).toBe(true);
  });
});
