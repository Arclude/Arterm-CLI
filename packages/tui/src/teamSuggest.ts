/**
 * Cheap, zero-latency heuristic for "this prompt looks like a multi-part job"
 * — the gate for the /team auto-suggestion. Deliberately conservative: a hit
 * only produces a y/N OFFER in the TUI, never a silent mode switch, so a false
 * positive costs one keypress. Pure function (no model probe — that would add a
 * round-trip to every submit).
 */
export function looksLikeBigTask(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 200) return false;

  // Several enumerated items read as independent work packages.
  const lines = trimmed.split(/\r?\n/);
  const bullets = lines.filter((l) => /^\s*([-*•]|\d+[.)])\s+/.test(l)).length;
  if (bullets >= 3) return true;

  // Long prose: look for chained scopes ("and then", "also", …; TR equivalents)
  // or simply many substantial sentences.
  if (trimmed.length < 300) return false;
  const connectors =
    trimmed.match(/\b(and then|then|after that|also|as well as|ayrıca|sonra|bir de)\b/gi)?.length ??
    0;
  const sentences = trimmed.split(/[.!?]+\s/).filter((s) => s.trim().length > 20).length;
  return connectors >= 3 || sentences >= 4;
}
