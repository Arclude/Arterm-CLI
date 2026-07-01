import { createHash } from "node:crypto";
import type { ObsType } from "./types.js";
import { OBS_TYPES, toObsType } from "./types.js";

/**
 * A pluggable extraction "mode": the observation taxonomy plus the prompt/parser
 * that turn a session's raw activity into structured observations. Modelled on
 * claude-mem's `modes/code.json`; a future taxonomy (docs, research, …) can drop
 * in by implementing this interface without touching the observer.
 */

/** One buffered unit of session activity fed to the observer. */
export interface RawActivity {
  source: "tool" | "assistant" | "user";
  label: string;
  text: string;
}

/** The content fields the observer extracts, before store bookkeeping is added. */
export interface ParsedObservation {
  type: ObsType;
  title: string;
  subtitle?: string;
  facts: string[];
  narrative: string;
  concepts: string[];
  filesRead: string[];
  filesModified: string[];
}

/** A named extraction taxonomy + prompt + parser. */
export interface ExtractionMode {
  readonly id: string;
  readonly types: readonly ObsType[];
  buildPrompt(activity: RawActivity[]): string;
  parse(output: string): ParsedObservation[];
}

const CONCEPT_VOCAB = [
  "how-it-works",
  "why-it-exists",
  "what-changed",
  "problem-solution",
  "gotcha",
  "pattern",
  "trade-off",
];

function splitList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[;,\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Stable dedup hash for a parsed observation within a project. */
export function hashObservation(p: ParsedObservation, project: string): string {
  const normalized = [project, p.type, p.title.trim().toLowerCase(), p.narrative.trim()].join("|");
  return createHash("sha1").update(normalized).digest("hex").slice(0, 16);
}

/** The default code-oriented extraction mode. */
export const defaultMode: ExtractionMode = {
  id: "code",
  types: OBS_TYPES,

  buildPrompt(activity: RawActivity[]): string {
    const log = activity.map((a, i) => `[${i + 1}] (${a.source}:${a.label}) ${a.text}`).join("\n");
    return [
      "You are Arterm-Mem, a specialized observer that writes searchable memory FOR",
      "FUTURE coding sessions. Below is the activity log of the session you observed:",
      "tool results and assistant messages. You are NOT doing the work — you are",
      "recording the DURABLE facts worth remembering later (decisions, bug fixes,",
      "features, refactors, and non-obvious discoveries). Ignore transient chatter and",
      "routine file reads.",
      "",
      "Output at most 6 observations. Each is a block that starts with '###' followed",
      "by the title, then KEY: value lines. Use EXACTLY these keys:",
      "### <short one-line title>",
      `TYPE: one of ${OBS_TYPES.join(", ")}`,
      "SUBTITLE: one sentence, at most 24 words",
      "FACTS: self-contained statements separated by ';'",
      "NARRATIVE: what happened, how, and why (2-4 sentences)",
      `CONCEPTS: comma-separated, 2-5 of: ${CONCEPT_VOCAB.join(", ")}`,
      "FILES_READ: comma-separated paths (or empty)",
      "FILES_MODIFIED: comma-separated paths (or empty)",
      "",
      "If nothing is worth remembering, output exactly: NONE",
      "",
      "ACTIVITY LOG:",
      log,
    ].join("\n");
  },

  parse(output: string): ParsedObservation[] {
    if (/^\s*NONE\s*$/i.test(output)) return [];
    const blocks: string[] = [];
    let current: string[] | null = null;
    for (const line of output.split("\n")) {
      if (/^\s*###/.test(line)) {
        if (current) blocks.push(current.join("\n"));
        current = [line];
      } else if (current) {
        current.push(line);
      }
    }
    if (current) blocks.push(current.join("\n"));

    const result: ParsedObservation[] = [];
    for (const block of blocks) {
      const lines = block.split("\n");
      const titleLine = lines[0] ?? "";
      const title = titleLine.replace(/^\s*#+\s*/, "").trim();
      if (!title) continue;
      const fields = new Map<string, string>();
      for (const line of lines.slice(1)) {
        const m = /^\s*([A-Z_]+)\s*:\s*(.*)$/.exec(line);
        if (m?.[1]) fields.set(m[1].toUpperCase(), (m[2] ?? "").trim());
      }
      const subtitle = fields.get("SUBTITLE");
      result.push({
        type: toObsType(fields.get("TYPE")),
        title,
        ...(subtitle ? { subtitle } : {}),
        facts: splitList(fields.get("FACTS")),
        narrative: fields.get("NARRATIVE") ?? "",
        concepts: splitList(fields.get("CONCEPTS")),
        filesRead: splitList(fields.get("FILES_READ")),
        filesModified: splitList(fields.get("FILES_MODIFIED")),
      });
    }
    return result;
  },
};
