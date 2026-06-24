import { randomUUID } from "node:crypto";
import type { LearningType, MemoryRecord, MemoryStore, Tool } from "@arterm/core";
import { CodeIndex } from "./codeIndex.js";
import { requireString } from "./paths.js";

const DEFAULT_LIMIT = 8;
const LEARNING_TYPES: LearningType[] = ["feature", "bugfix", "decision", "discovery", "note"];

/** The text a learning is indexed/displayed by. */
function learningText(r: MemoryRecord): string {
  return [r.title, r.body ?? "", (r.files ?? []).join(" ")].join(" ");
}

function formatLearning(r: MemoryRecord): string {
  const files = r.files && r.files.length > 0 ? ` (${r.files.join(", ")})` : "";
  const body = r.body ? ` — ${r.body}` : "";
  return `[${r.type}] ${r.title}${body}${files}`;
}

/**
 * `memory_search`: BM25-ranked recall over the project's persisted learnings.
 * The progressive-disclosure surface (claude-mem's MCP search, in-process here).
 */
export function createMemorySearchTool(store: MemoryStore): Tool {
  return {
    name: "memory_search",
    description:
      "Search this project's persistent memory (durable facts learned in previous sessions): " +
      "decisions, bug fixes, features, and discoveries. Use this to recall how something was " +
      "done before or whether a problem was already solved.",
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
    preview: (args) => `memory_search "${String(args.query)}"`,
    async execute(args) {
      const query = requireString(args, "query");
      const limitRaw = args.limit;
      const limit =
        typeof limitRaw === "number" && limitRaw > 0 ? Math.floor(limitRaw) : DEFAULT_LIMIT;

      const records = await store.all();
      if (records.length === 0) return { output: "Project memory is empty." };

      const index = new CodeIndex();
      const byId = new Map<string, MemoryRecord>();
      for (const r of records) {
        index.addDocument(r.id, learningText(r));
        byId.set(r.id, r);
      }
      const hits = index.search(query, limit);
      if (hits.length === 0) return { output: `No memory matches for "${query}".` };

      const lines = hits
        .map((h) => byId.get(h.path))
        .filter((r): r is MemoryRecord => r !== undefined)
        .map(formatLearning);
      return { output: lines.join("\n") };
    },
  };
}

/**
 * `remember`: explicitly persist a durable fact to project memory. Complements
 * the automatic end-of-session digest — useful for facts the user states directly.
 */
export function createRememberTool(store: MemoryStore, now: () => number = Date.now): Tool {
  return {
    name: "remember",
    description:
      "Save a durable fact to this project's persistent memory so it's available in future " +
      "sessions. Use when the user states a lasting preference, decision, or fact worth keeping.",
    permission: "allow",
    category: "read",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short one-line summary of the fact." },
        type: {
          type: "string",
          enum: LEARNING_TYPES,
          description: "Classification (default note).",
        },
        body: { type: "string", description: "Optional detail (one or two sentences)." },
        files: {
          type: "array",
          items: { type: "string" },
          description: "Optional relevant file paths.",
        },
      },
      required: ["title"],
    },
    preview: (args) => `remember "${String(args.title)}"`,
    async execute(args) {
      const title = requireString(args, "title");
      const typeRaw =
        typeof args.type === "string" ? (args.type.toLowerCase() as LearningType) : "";
      const type: LearningType = LEARNING_TYPES.includes(typeRaw as LearningType)
        ? (typeRaw as LearningType)
        : "note";
      const body = typeof args.body === "string" && args.body.trim() ? args.body.trim() : undefined;
      const files = Array.isArray(args.files)
        ? args.files.filter((f): f is string => typeof f === "string" && f.trim().length > 0)
        : undefined;

      const record: MemoryRecord = {
        id: randomUUID(),
        kind: "learning",
        ts: now(),
        type,
        title,
        ...(body ? { body } : {}),
        ...(files && files.length > 0 ? { files } : {}),
      };
      await store.append(record);
      return { output: `Remembered: ${formatLearning(record)}` };
    },
  };
}
