import { describe, expect, it } from "vitest";
import { formatRateLimits } from "./limitsView.js";

const NOW = Date.parse("2026-08-05T12:00:00");

describe("formatRateLimits (/limits rendering)", () => {
  it("parses Anthropic's role-last grammar into family lines with percentages", () => {
    const lines = formatRateLimits(
      {
        at: NOW - 5_000,
        headers: {
          "anthropic-ratelimit-requests-limit": "50",
          "anthropic-ratelimit-requests-remaining": "42",
          "anthropic-ratelimit-requests-reset": "2026-08-05T12:00:40",
          "anthropic-ratelimit-input-tokens-limit": "30000",
          "anthropic-ratelimit-input-tokens-remaining": "15000",
        },
      },
      NOW,
    );
    const text = lines.join("\n");
    expect(text).toContain("requests");
    expect(text).toContain("42 / 50 (84% left)");
    expect(text).toContain("15000 / 30000 (50% left)");
    // RFC3339 reset → local wall clock + relative.
    expect(text).toContain("resets 12:00 (in 1m)");
    expect(text).toContain("as of 5s ago");
    // requests family sorts before token pools.
    expect(text.indexOf("requests")).toBeLessThan(text.indexOf("input-tokens"));
  });

  it("parses OpenAI's role-first grammar and keeps duration resets verbatim", () => {
    const text = formatRateLimits(
      {
        at: NOW,
        headers: {
          "x-ratelimit-limit-requests": "500",
          "x-ratelimit-remaining-requests": "499",
          "x-ratelimit-reset-requests": "6m0s",
        },
      },
      NOW,
    ).join("\n");
    expect(text).toContain("499 / 500 (100% left)");
    // "6m0s" is not a date — inventing a wall-clock time for it would be wrong.
    expect(text).toContain("resets 6m0s");
  });

  it("prints headers that fit no family raw — unrecognized is information, not noise", () => {
    const text = formatRateLimits(
      {
        at: NOW,
        headers: {
          "anthropic-ratelimit-unified-status": "allowed_warning",
          "retry-after": "30",
        },
      },
      NOW,
    ).join("\n");
    expect(text).toContain("unified-status: allowed_warning");
    expect(text).toContain("retry-after: 30");
  });
});
