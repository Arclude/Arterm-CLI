import { describe, expect, it } from "vitest";
import { harvestRateLimits } from "./rateLimits.js";

describe("harvestRateLimits", () => {
  it("collects anthropic-ratelimit-* headers and lets retry-after ride along", () => {
    const snap = harvestRateLimits(
      new Headers({
        "anthropic-ratelimit-requests-remaining": "42",
        "anthropic-ratelimit-requests-limit": "50",
        "retry-after": "7",
        "content-type": "application/json",
      }),
    );
    expect(snap?.headers).toEqual({
      "anthropic-ratelimit-requests-remaining": "42",
      "anthropic-ratelimit-requests-limit": "50",
      "retry-after": "7",
    });
    expect(typeof snap?.at).toBe("number");
  });

  it("matches OpenAI-style x-ratelimit-* names too", () => {
    const snap = harvestRateLimits(new Headers({ "x-ratelimit-remaining-tokens": "9000" }));
    expect(snap?.headers["x-ratelimit-remaining-tokens"]).toBe("9000");
  });

  it("returns undefined for a response with no report — callers keep the old snapshot", () => {
    // retry-after alone says nothing about quotas, so it must not fabricate one.
    expect(harvestRateLimits(new Headers({ "retry-after": "3", "content-type": "x" }))).toBe(
      undefined,
    );
  });
});
