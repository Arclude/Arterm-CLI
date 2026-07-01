import type { Tool } from "@arterm/core";
import { estimateTokens } from "@arterm/core";
import type { Embedder } from "./embedder.js";
import { hashObservation } from "./mode.js";
import type { ParsedObservation } from "./mode.js";
import { readTokensFor } from "./observer.js";
import { formatRow } from "./recall.js";
import { hybridSearch } from "./search.js";
import type { MemStore } from "./store.js";
import type { Observation, ObservationInput } from "./types.js";
import { OBS_TYPES, TYPE_ICON, toLegendRow, toObsType } from "./types.js";

/**
 * The agent-facing tool surface for the rich memory engine. `mem_search` +
 * `get_observations` + `timeline` form claude-mem's 3-layer progressive-disclosure
 * workflow (search compact rows → fetch full detail by id → explore neighbors);
 * `remember_observation` is explicit user-driven capture. The workflow contract is
 * embedded in each tool's description so the model follows it.
 */

const DEFAULT_LIMIT = 8;

/** Dependencies a tool set closes over. */
export interface CmemToolDeps {
  store: MemStore;
  embedder: Embedder;
  project: string;
  now?: () => number;
}

function limitOf(args: Record<string, unknown>, fallback = DEFAULT_LIMIT): number {
  const raw = args.limit;
  return typeof raw === "number" && raw > 0 ? Math.floor(raw) : fallback;
}

function requireString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || !v.trim()) throw new Error(`Missing required "${key}"`);
  return v.trim();
}

function stringList(v: unknown): string[] {
  return Array.isArray(v)
    ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0)
    : [];
}

/** Full, on-demand rendering of an observation (the expensive fetch). */
function formatFull(o: Observation): string {
  const lines = [`#${o.id} ${TYPE_ICON[o.type]} [${o.type}] ${o.title}`];
  if (o.subtitle) lines.push(o.subtitle);
  if (o.facts.length) lines.push(`Facts: ${o.facts.map((f) => `• ${f}`).join(" ")}`);
  if (o.narrative) lines.push(o.narrative);
  if (o.concepts.length) lines.push(`Concepts: ${o.concepts.join(", ")}`);
  if (o.filesRead.length) lines.push(`Files read: ${o.filesRead.join(", ")}`);
  if (o.filesModified.length) lines.push(`Files modified: ${o.filesModified.join(", ")}`);
  return lines.join("\n");
}

function memSearchTool(deps: CmemToolDeps): Tool {
  return {
    name: "mem_search",
    description:
      "Search this project's rich session memory (semantic + lexical). Returns COMPACT rows only " +
      "(#id time icon title ~tokens) — a progressive-disclosure index. IMPORTANT: to read the full " +
      "narrative/facts for any hit, call get_observations([ids]); do not expect full detail here.",
    permission: "allow",
    category: "read",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Words to search memory for." },
        limit: { type: "number", description: `Max results (default ${DEFAULT_LIMIT}).` },
      },
      required: ["query"],
    },
    preview: (args) => `mem_search "${String(args.query)}"`,
    async execute(args) {
      const query = requireString(args, "query");
      const hits = await hybridSearch({
        store: deps.store,
        embedder: deps.embedder,
        query,
        limit: limitOf(args),
      });
      if (hits.length === 0) return { output: `No memory matches for "${query}".` };
      return { output: hits.map(formatRow).join("\n") };
    },
  };
}

function getObservationsTool(deps: CmemToolDeps): Tool {
  return {
    name: "get_observations",
    description:
      "Fetch FULL detail (narrative, facts, files, concepts) for observation ids from the " +
      "session-start legend or mem_search. IMPORTANT: batch every id you need into one call " +
      "(~300 tokens each) — this is the on-demand half of progressive disclosure.",
    permission: "allow",
    category: "read",
    parameters: {
      type: "object",
      properties: {
        ids: {
          type: "array",
          items: { type: "number" },
          description: "Observation ids to expand.",
        },
      },
      required: ["ids"],
    },
    preview: (args) => `get_observations [${(args.ids as unknown[])?.join(", ") ?? ""}]`,
    async execute(args) {
      const ids = Array.isArray(args.ids)
        ? args.ids.filter((x): x is number => typeof x === "number")
        : [];
      if (ids.length === 0) return { output: "No ids provided." };
      const found = await deps.store.get(ids);
      if (found.length === 0) return { output: `No observations found for [${ids.join(", ")}].` };
      const missing = ids.filter((id) => !found.some((o) => o.id === id));
      const blocks = found.map(formatFull);
      if (missing.length) blocks.push(`(not found: ${missing.join(", ")})`);
      return { output: blocks.join("\n\n") };
    },
  };
}

function timelineTool(deps: CmemToolDeps): Tool {
  return {
    name: "timeline",
    description:
      "Show observations chronologically around an anchor id — the work just before and after a " +
      "moment. Returns COMPACT rows; follow with get_observations for full detail.",
    permission: "allow",
    category: "read",
    parameters: {
      type: "object",
      properties: {
        anchor: { type: "number", description: "Observation id to center on." },
        before: { type: "number", description: "How many earlier observations (default 3)." },
        after: { type: "number", description: "How many later observations (default 3)." },
      },
      required: ["anchor"],
    },
    preview: (args) => `timeline @#${String(args.anchor)}`,
    async execute(args) {
      const anchor = typeof args.anchor === "number" ? args.anchor : Number.NaN;
      if (!Number.isFinite(anchor)) return { output: "A numeric anchor id is required." };
      const before = typeof args.before === "number" ? args.before : 3;
      const after = typeof args.after === "number" ? args.after : 3;
      const rows = await deps.store.around(anchor, before, after);
      if (rows.length === 0) return { output: `No observations around #${anchor}.` };
      return { output: rows.map((o) => formatRow(toLegendRow(o))).join("\n") };
    },
  };
}

function rememberTool(deps: CmemToolDeps): Tool {
  const now = deps.now ?? Date.now;
  return {
    name: "remember_observation",
    description:
      "Persist a durable, richly-typed observation to project memory for future sessions. Use for " +
      "a decision, bug fix, feature, refactor, change, or non-obvious discovery worth keeping.",
    permission: "allow",
    category: "read",
    parameters: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: OBS_TYPES as unknown as string[],
          description: "Classification.",
        },
        title: { type: "string", description: "Short one-line title." },
        subtitle: { type: "string", description: "One-sentence explanation." },
        facts: { type: "array", items: { type: "string" }, description: "Self-contained facts." },
        narrative: { type: "string", description: "What / how / why." },
        concepts: { type: "array", items: { type: "string" }, description: "Concept tags." },
        filesRead: { type: "array", items: { type: "string" }, description: "Files read." },
        filesModified: { type: "array", items: { type: "string" }, description: "Files modified." },
      },
      required: ["type", "title"],
    },
    preview: (args) => `remember_observation "${String(args.title)}"`,
    async execute(args) {
      const title = requireString(args, "title");
      const parsed: ParsedObservation = {
        type: toObsType(typeof args.type === "string" ? args.type : undefined),
        title,
        ...(typeof args.subtitle === "string" && args.subtitle.trim()
          ? { subtitle: args.subtitle.trim() }
          : {}),
        facts: stringList(args.facts),
        narrative: typeof args.narrative === "string" ? args.narrative.trim() : "",
        concepts: stringList(args.concepts),
        filesRead: stringList(args.filesRead),
        filesModified: stringList(args.filesModified),
      };
      const contentHash = hashObservation(parsed, deps.project);
      if (await deps.store.hasHash(contentHash)) {
        return { output: `Already remembered: ${TYPE_ICON[parsed.type]} ${parsed.title}` };
      }
      const embedding = await deps.embedder.embed(
        [parsed.title, parsed.subtitle ?? "", parsed.narrative].join(" ").trim(),
      );
      const readTokens = readTokensFor(parsed);
      const input: ObservationInput = {
        ts: now(),
        project: deps.project,
        type: parsed.type,
        title: parsed.title,
        ...(parsed.subtitle ? { subtitle: parsed.subtitle } : {}),
        facts: parsed.facts,
        narrative: parsed.narrative,
        concepts: parsed.concepts,
        filesRead: parsed.filesRead,
        filesModified: parsed.filesModified,
        // Explicit captures claim no compression savings over their own detail.
        discoveryTokens: Math.max(readTokens, estimateTokens(parsed.narrative)),
        readTokens,
        contentHash,
        embedding,
      };
      const id = await deps.store.put(input);
      if (id === null) return { output: `Could not save: ${parsed.title}` };
      return { output: `Remembered #${id}: ${TYPE_ICON[parsed.type]} ${parsed.title}` };
    },
  };
}

/** Build the four progressive-disclosure memory tools. */
export function createCmemTools(deps: CmemToolDeps): Tool[] {
  return [memSearchTool(deps), getObservationsTool(deps), timelineTool(deps), rememberTool(deps)];
}
