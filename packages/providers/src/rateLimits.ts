import type { RateLimitSnapshot } from "@arterm/core";

/**
 * Harvest rate-limit headers from a provider response.
 *
 * Matches by substring — `anthropic-ratelimit-requests-remaining`,
 * `x-ratelimit-limit-tokens`, whatever a vendor renames next — rather than a
 * hard-coded list, so a new header shows up in `/limits` without a code change.
 * `retry-after` rides along only when real rate-limit headers are present;
 * alone it says nothing about quotas. Returns undefined when the response
 * carries no report, so callers keep their previous (still useful) snapshot
 * instead of clobbering it with an empty one.
 */
export function harvestRateLimits(headers: Headers): RateLimitSnapshot | undefined {
  const out: Record<string, string> = {};
  headers.forEach((value, name) => {
    if (name.toLowerCase().includes("ratelimit")) out[name.toLowerCase()] = value;
  });
  if (Object.keys(out).length === 0) return undefined;
  const retryAfter = headers.get("retry-after");
  if (retryAfter !== null) out["retry-after"] = retryAfter;
  return { at: Date.now(), headers: out };
}
