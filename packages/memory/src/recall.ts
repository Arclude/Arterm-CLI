import type { LegendRow, Observation } from "./types.js";
import { OBS_TYPES, TYPE_ICON } from "./types.js";

/**
 * The session-start "legend" and its token-savings figure — the core of the
 * progressive-disclosure design. Only a compact index (id + time + type + title +
 * fetch cost) is injected each session; full narratives are pulled on demand via
 * `get_observations`. Savings = Σ discoveryTokens − Σ readTokens.
 */

/** Aggregate token bookkeeping across a set of observations. */
export interface SavingsInfo {
  discoveryTokens: number;
  readTokens: number;
  savingsPct: number;
}

/** Sum discovery/read tokens and derive the reduction percentage (guarded). */
export function computeSavings(
  obs: { discoveryTokens: number; readTokens: number }[],
): SavingsInfo {
  let discoveryTokens = 0;
  let readTokens = 0;
  for (const o of obs) {
    discoveryTokens += o.discoveryTokens;
    readTokens += o.readTokens;
  }
  const saved = discoveryTokens - readTokens;
  const savingsPct =
    discoveryTokens > 0 ? Math.max(0, Math.round((saved / discoveryTokens) * 100)) : 0;
  return { discoveryTokens, readTokens, savingsPct };
}

function hhmm(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Render one compact legend/search row: `#id HH:MM icon title  ~Nt`. */
export function formatRow(row: LegendRow): string {
  return `#${row.id} ${hhmm(row.ts)} ${TYPE_ICON[row.type]}  ${row.title}  ~${row.readTokens}t`;
}

/** Plain-text dump of full observations for the terminal (`arterm memory ls`). */
export function formatObservationsText(observations: Observation[]): string {
  if (observations.length === 0) return "(no observations for this project yet)";
  const lines = observations.map((o) => {
    const when = new Date(o.ts).toISOString().slice(0, 16).replace("T", " ");
    const head = `${when}  ${TYPE_ICON[o.type]}  #${o.id} [${o.type}] ${o.title}`;
    const sub = o.subtitle ? `\n      ${o.subtitle}` : "";
    const facts = o.facts.length ? `\n      · ${o.facts.join("\n      · ")}` : "";
    const files = [...o.filesModified, ...o.filesRead];
    const filesLine = files.length ? `\n      [${files.join(", ")}]` : "";
    return `${head}${sub}${facts}${filesLine}`;
  });
  const s = computeSavings(observations);
  const footer = `\nSaved ~${s.savingsPct}% (${s.discoveryTokens}→${s.readTokens} tokens across ${observations.length}).`;
  return `${lines.join("\n")}\n${footer}`;
}

/** Render the full session-start legend block (empty string when no rows). */
export function renderLegend(rows: LegendRow[], savings: SavingsInfo): string {
  if (rows.length === 0) return "";
  const legend = OBS_TYPES.map((t) => `${TYPE_ICON[t]} ${t}`).join("  ");
  const header = [
    "Project memory — observations from previous sessions (most recent last).",
    `Legend: ${legend}`,
    "Format: #ID TIME TYPE TITLE ~readTokens",
    "Progressive disclosure: call get_observations([IDs]) for full detail, mem_search to find" +
      " more, timeline(anchor) for neighbors. Do NOT expect full detail in this index.",
  ];
  const body = rows.map(formatRow);
  const footer =
    `Saved ~${savings.savingsPct}% by reuse ` +
    `(${savings.discoveryTokens}→${savings.readTokens} tokens across ${rows.length} observations).`;
  return [...header, "", ...body, "", footer].join("\n");
}
