import { describe, expect, it } from "vitest";
import {
  ProviderError,
  formatWait,
  isAbortError,
  isReplayable,
  kindForStatus,
  normalizeProviderError,
  parseRetryAfter,
  providerErrorFromResponse,
} from "./providerError.js";

describe("ProviderError.is", () => {
  it("recognizes its own instances", () => {
    const err = new ProviderError("boom", { provider: "ollama", kind: "network" });
    expect(ProviderError.is(err)).toBe(true);
  });

  it("recognizes a structurally identical error from a duplicate module copy", () => {
    // What a second, hoisted copy of this module produces: same shape, different
    // class identity — `instanceof` would return false and silently disable retry.
    const foreign = Object.assign(new Error("boom"), {
      name: "ProviderError",
      provider: "anthropic",
      kind: "quota",
      status: 429,
      retryable: true,
      retryAfter: null,
    });
    expect(foreign instanceof ProviderError).toBe(false);
    expect(ProviderError.is(foreign)).toBe(true);
  });

  it("rejects unrelated errors and non-objects", () => {
    expect(ProviderError.is(new Error("nope"))).toBe(false);
    expect(ProviderError.is({ name: "ProviderError" })).toBe(false);
    expect(ProviderError.is(null)).toBe(false);
    expect(ProviderError.is("ProviderError")).toBe(false);
  });
});

describe("kindForStatus", () => {
  it("maps statuses onto retry-relevant kinds", () => {
    expect(kindForStatus(401)).toBe("auth");
    expect(kindForStatus(403)).toBe("auth");
    expect(kindForStatus(408)).toBe("timeout");
    expect(kindForStatus(429)).toBe("quota");
    expect(kindForStatus(503)).toBe("overloaded");
    expect(kindForStatus(529)).toBe("overloaded");
    expect(kindForStatus(500)).toBe("server");
    expect(kindForStatus(400)).toBe("bad_request");
  });
});

describe("retryable", () => {
  it("is derived from the kind, not the status", () => {
    const kinds = ["network", "timeout", "quota", "overloaded", "server"] as const;
    for (const kind of kinds) {
      expect(new ProviderError("x", { provider: "p", kind }).retryable).toBe(true);
    }
    for (const kind of ["auth", "bad_request", "unknown"] as const) {
      expect(new ProviderError("x", { provider: "p", kind }).retryable).toBe(false);
    }
  });
});

describe("normalizeProviderError", () => {
  it("passes a ProviderError through untouched", () => {
    const original = new ProviderError("boom", { provider: "ollama", kind: "server" });
    expect(normalizeProviderError(original, "ollama")).toBe(original);
  });

  it("classifies a mid-stream socket death as retryable network", () => {
    // This is what `fetch` throws when the connection drops mid-body: an opaque
    // TypeError whose real reason only lives on `cause`.
    const terminated = Object.assign(new TypeError("terminated"), {
      cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }),
    });
    const err = normalizeProviderError(terminated, "openai-compat");
    expect(err.kind).toBe("network");
    expect(err.retryable).toBe(true);
    expect(err.status).toBe(0);
    expect(err.message).toContain("UND_ERR_SOCKET");
  });

  it("classifies bare connection codes without a message match", () => {
    const reset = Object.assign(new Error("read failure"), { code: "ECONNRESET" });
    expect(normalizeProviderError(reset, "ollama").kind).toBe("network");
  });

  it("reads the status off an SDK error", () => {
    const apiError = Object.assign(new Error("rate_limit_error"), { status: 429 });
    const err = normalizeProviderError(apiError, "anthropic");
    expect(err.kind).toBe("quota");
    expect(err.status).toBe(429);
    expect(err.retryable).toBe(true);
  });

  it("classifies the idle guard's own deadline as a timeout", () => {
    const idle = new Error("stream idle: no data for 120000ms");
    const err = normalizeProviderError(idle, "ollama");
    expect(err.kind).toBe("timeout");
    // Retryable in principle, but never replayed — a second idle window would
    // just buy another two minutes of silence.
    expect(err.retryable).toBe(true);
    expect(isReplayable(err)).toBe(false);
  });

  it("falls back to unknown and keeps the original message", () => {
    const err = normalizeProviderError(new Error("something odd"), "ollama");
    expect(err.kind).toBe("unknown");
    expect(err.retryable).toBe(false);
    expect(err.message).toContain("something odd");
  });
});

describe("isAbortError", () => {
  it("recognizes cancellation so it is never mistaken for a failure", () => {
    expect(isAbortError(new DOMException("aborted", "AbortError"))).toBe(true);
    expect(isAbortError(new DOMException("timed out", "TimeoutError"))).toBe(true);
    expect(isAbortError(new Error("terminated"))).toBe(false);
  });
});

describe("providerErrorFromResponse", () => {
  it("carries status, kind, and the Retry-After hint", async () => {
    const res = new Response("slow down", {
      status: 429,
      headers: { "retry-after": "12" },
    });
    const err = await providerErrorFromResponse("openai-compat", res, "/chat/completions");
    expect(err.kind).toBe("quota");
    expect(err.status).toBe(429);
    expect(err.retryAfter).toBe("12");
    expect(err.message).toContain("/chat/completions failed: HTTP 429");
    expect(err.message).toContain("slow down");
  });

  it("truncates a giant error body instead of pasting it into the transcript", async () => {
    const res = new Response("x".repeat(5000), { status: 500 });
    const err = await providerErrorFromResponse("ollama", res, "/api/chat");
    expect(err.message.length).toBeLessThan(800);
    expect(err.message).toContain("…");
  });

  it("names the credential fix on an auth failure", async () => {
    const res = new Response("invalid key", { status: 401 });
    const err = await providerErrorFromResponse("anthropic", res, "/messages");
    expect(err.kind).toBe("auth");
    expect(err.retryable).toBe(false);
    expect(err.message).toContain("arterm auth set anthropic");
  });

  it("tells the user how long the rate limit lasts and how to route around it", async () => {
    const res = new Response("rate limited", {
      status: 429,
      headers: { "retry-after": "3600" },
    });
    const err = await providerErrorFromResponse("anthropic", res, "/messages");
    expect(err.retryAfterMs).toBe(3_600_000);
    expect(err.message).toContain("1h");
    expect(err.message).toContain("fallbackModels");
  });
});

describe("parseRetryAfter", () => {
  const now = Date.parse("2026-07-26T12:00:00Z");

  it("reads delta-seconds", () => {
    expect(parseRetryAfter("42")).toBe(42_000);
    expect(parseRetryAfter("0")).toBe(0);
  });

  it("reads an HTTP date as a delay from now", () => {
    expect(parseRetryAfter("Sun, 26 Jul 2026 12:05:00 GMT", now)).toBe(300_000);
  });

  it("ignores a date already in the past", () => {
    expect(parseRetryAfter("Sun, 26 Jul 2026 11:55:00 GMT", now)).toBeNull();
  });

  it("returns null for absent or unparseable values", () => {
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter(undefined)).toBeNull();
    expect(parseRetryAfter("  ")).toBeNull();
    expect(parseRetryAfter("soon")).toBeNull();
    expect(parseRetryAfter("-5")).toBeNull();
  });
});

describe("formatWait", () => {
  it("scales the unit to the magnitude", () => {
    expect(formatWait(45_000)).toBe("45s");
    expect(formatWait(12 * 60_000)).toBe("12m");
    expect(formatWait(60 * 60_000)).toBe("1h");
    expect(formatWait(65 * 60_000)).toBe("1h 5m");
  });
});
