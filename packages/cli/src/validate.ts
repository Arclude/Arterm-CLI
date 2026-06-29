/**
 * Pure input-validation helpers, kept free of side effects (no `process.exit`,
 * no workspace imports) so they're trivially unit-testable. Callers in `main.ts`
 * pair these with `fail()` / `ArtermUserError` to turn a `false`/`null` result
 * into a clean, actionable error message.
 */

/** True when `id` names a provider the CLI knows how to build. */
export function isKnownProvider(id: string, knownIds: readonly string[]): boolean {
  return knownIds.includes(id);
}

/** A friendly "unknown provider" message listing the valid ids. */
export function unknownProviderMessage(id: string, knownIds: readonly string[]): string {
  return `Unknown provider: "${id}". Valid providers: ${knownIds.join(", ")}.`;
}

/**
 * Parse a `--port` value. Returns the port number, the fallback when `raw` is
 * absent, or `null` when it isn't an integer in the valid TCP range (1–65535).
 */
export function parsePort(raw: string | undefined, fallback: number): number | null {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return null;
  return n;
}
