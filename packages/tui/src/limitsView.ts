import type { RateLimitSnapshot } from "@arterm/core";

/**
 * Render a provider's rate-limit snapshot as transcript lines (for /limits).
 *
 * The headers arrive in two vendor grammars — Anthropic's `…-requests-limit`
 * (role last) and OpenAI's `…-limit-requests` (role first) — so the parser
 * normalizes both into (family, role) pairs instead of hard-coding names.
 * Whatever doesn't fit that shape (unified-status, fallback percentages,
 * retry-after) is still printed raw at the bottom: an unrecognized header is
 * information, not noise.
 */
export function formatRateLimits(snap: RateLimitSnapshot, now: number = Date.now()): string[] {
  const ROLES = new Set(["limit", "remaining", "reset"]);
  type Family = { limit?: string; remaining?: string; reset?: string };
  const families = new Map<string, Family>();
  const leftovers: string[] = [];

  for (const [rawName, value] of Object.entries(snap.headers)) {
    // Strip the vendor prefix: anthropic-ratelimit-, x-ratelimit-, ratelimit-.
    const name = rawName.replace(/^(anthropic-|x-)?ratelimit-/, "");
    const parts = name.split("-");
    const first = parts[0] ?? "";
    const last = parts[parts.length - 1] ?? "";
    let role: string | undefined;
    let family: string | undefined;
    if (ROLES.has(first) && parts.length > 1) {
      role = first;
      family = parts.slice(1).join("-");
    } else if (ROLES.has(last) && parts.length > 1) {
      role = last;
      family = parts.slice(0, -1).join("-");
    }
    if (role && family) {
      const f = families.get(family) ?? {};
      f[role as keyof Family] = value;
      families.set(family, f);
    } else {
      leftovers.push(`${name}: ${value}`);
    }
  }

  // Stable, meaningful order: requests first, token pools next, the rest alpha.
  const PREFERRED = ["requests", "input-tokens", "output-tokens", "tokens"];
  const keys = [...families.keys()].sort((a, b) => {
    const ia = PREFERRED.indexOf(a);
    const ib = PREFERRED.indexOf(b);
    if (ia !== -1 || ib !== -1) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    return a.localeCompare(b);
  });

  const lines: string[] = [];
  for (const key of keys) {
    // `key` came out of `families.keys()`, so the lookup cannot miss — but
    // `Map.get` is typed `V | undefined` regardless, which is what the
    // assertion answers. (Not a biome-ignore: `noNonNullAssertion` is off
    // project-wide, so the suppression this replaced silenced nothing.)
    const f = families.get(key)!;
    const parts: string[] = [];
    if (f.remaining !== undefined && f.limit !== undefined) {
      const rem = Number(f.remaining);
      const lim = Number(f.limit);
      const pct =
        Number.isFinite(rem) && Number.isFinite(lim) && lim > 0
          ? ` (${Math.round((rem / lim) * 100)}% left)`
          : "";
      parts.push(`${f.remaining} / ${f.limit}${pct}`);
    } else if (f.remaining !== undefined) {
      parts.push(`${f.remaining} left`);
    } else if (f.limit !== undefined) {
      parts.push(`limit ${f.limit}`);
    }
    if (f.reset !== undefined) parts.push(`resets ${formatReset(f.reset, now)}`);
    if (parts.length > 0) lines.push(`  ${key.padEnd(14)} ${parts.join(" · ")}`);
  }
  lines.push(...leftovers.map((l) => `  ${l}`));

  const age = Math.max(0, Math.round((now - snap.at) / 1000));
  lines.push(`  as of ${age}s ago — refreshed by every reply`);
  return lines;
}

/** RFC3339 resets become local wall-clock + relative; durations stay as sent. */
function formatReset(value: string, now: number): string {
  const t = Date.parse(value);
  if (Number.isNaN(t)) return value;
  const inSec = Math.max(0, Math.round((t - now) / 1000));
  const rel = inSec >= 3600 ? `${Math.round(inSec / 3600)}h` : `${Math.ceil(inSec / 60)}m`;
  const d = new Date(t);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm} (in ${rel})`;
}
