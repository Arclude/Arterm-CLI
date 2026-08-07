import { randomUUID } from "node:crypto";
import type { LearningType, MemoryRecord, MemoryStore, Tool, ToolResult } from "@arterm/core";
import { CodeIndex } from "./codeIndex.js";
import { requireString } from "./paths.js";

const DEFAULT_LIMIT = 8;
const LEARNING_TYPES: LearningType[] = ["feature", "bugfix", "decision", "discovery", "note"];

/**
 * How much of a record's id is printed — and therefore the most a caller can be
 * expected to copy back. Ids are UUIDs, and a model retyping 36 characters of
 * hex to address a record it wants deleted is a transcription error waiting to
 * happen; eight is git-short and collides with nothing at project-memory scale.
 */
const SHORT_ID_LEN = 8;

/** The text a learning is indexed/displayed by. */
function learningText(r: MemoryRecord): string {
  return [r.title, r.body ?? "", (r.files ?? []).join(" ")].join(" ");
}

/** The handle a caller quotes back to address one record. */
export function shortId(r: MemoryRecord): string {
  return r.id.slice(0, SHORT_ID_LEN);
}

/**
 * One-line human/agent-readable rendering of a learning.
 *
 * The id leads because it is the only part that is actionable: without it every
 * result is read-only prose, and `forget` has nothing to name.
 */
export function formatLearning(r: MemoryRecord): string {
  const files = r.files && r.files.length > 0 ? ` (${r.files.join(", ")})` : "";
  const body = r.body ? ` — ${r.body}` : "";
  return `${shortId(r)} [${r.type}] ${r.title}${body}${files}`;
}

/**
 * BM25 over the store's records — the ONE ranking behind both `memory_search`
 * and `find_related_memories`. A second scorer beside it would let "matches" and
 * "is related to" disagree about the same pair of records, and neither answer
 * would be checkable against the other.
 *
 * `excludeId` drops the anchor BEFORE indexing rather than filtering it out of
 * the hits: filtering afterwards silently returns one fewer result than asked
 * for, and the anchor's own terms would still be skewing the document
 * frequencies every other record is scored against.
 */
function rankMemories(
  records: readonly MemoryRecord[],
  query: string,
  limit: number,
  excludeId?: string,
): MemoryRecord[] {
  const index = new CodeIndex();
  const byId = new Map<string, MemoryRecord>();
  for (const r of records) {
    if (r.id === excludeId) continue;
    index.addDocument(r.id, learningText(r));
    byId.set(r.id, r);
  }
  return index
    .search(query, limit)
    .map((h) => byId.get(h.path))
    .filter((r): r is MemoryRecord => r !== undefined);
}

/** Read `limit` from args, falling back to the default for anything unusable. */
function limitOf(args: Record<string, unknown>): number {
  const raw = args.limit;
  return typeof raw === "number" && raw > 0 ? Math.floor(raw) : DEFAULT_LIMIT;
}

/** What resolving a caller-supplied id produced. */
type IdLookup =
  | { ok: true; record: MemoryRecord }
  | { ok: false; reason: "missing" }
  | { ok: false; reason: "ambiguous"; matches: MemoryRecord[] };

/**
 * Resolve a full id or any unambiguous prefix of one (git-style), since what a
 * caller has seen is the short form. Ambiguity is reported, never resolved by
 * picking the first — the caller of `forget` gets one shot at naming the right
 * record. Case is folded because every id this codebase writes is a lowercase
 * UUID, so it cannot merge two real records.
 */
function resolveId(records: readonly MemoryRecord[], id: string): IdLookup {
  const wanted = id.trim().toLowerCase();
  const exact = records.find((r) => r.id.toLowerCase() === wanted);
  if (exact) return { ok: true, record: exact };
  const matches = records.filter((r) => r.id.toLowerCase().startsWith(wanted));
  const first = matches[0];
  if (!first) return { ok: false, reason: "missing" };
  if (matches.length > 1) return { ok: false, reason: "ambiguous", matches };
  return { ok: true, record: first };
}

/** The error a failed lookup reports, so both tools say the same thing about ids. */
function lookupError(found: Extract<IdLookup, { ok: false }>, id: string): ToolResult {
  if (found.reason === "missing") {
    return {
      output: `No memory has id "${id}". Run memory_search — the id is the first field of every result.`,
      isError: true,
    };
  }
  const lines = found.matches.map(formatLearning).join("\n");
  return {
    output: `"${id}" matches ${found.matches.length} memories — pass more of the id:\n${lines}`,
    isError: true,
  };
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
      "done before or whether a problem was already solved. Every result starts with the id " +
      "that `forget` and `find_related_memories` take.",
    permission: "allow",
    category: "read",
    // `limit` is the model's to choose, so the roster alone does not bound this.
    maxOutputBytes: 16_384,
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
      const records = await store.all();
      if (records.length === 0) return { output: "Project memory is empty." };

      const hits = rankMemories(records, query, limitOf(args));
      if (hits.length === 0) return { output: `No memory matches for "${query}".` };
      return { output: hits.map(formatLearning).join("\n") };
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

/** Compare a quoted title to a stored one: case and run-of-whitespace only. */
function sameTitle(a: string, b: string): boolean {
  const norm = (s: string): string => s.trim().replace(/\s+/g, " ").toLowerCase();
  return norm(a) === norm(b);
}

/**
 * `forget`: delete one learning from project memory.
 *
 * WHY IT ASKS. Its two siblings are `permission: "allow"` / `category: "read"`,
 * which is right for them: a wrong `remember` is corrected by a later one, and a
 * search reads. This call is the only one on the memory surface that destroys
 * something, and the JSONL file is the only copy — no checkpoint, no git
 * history, no undo. So it is `ask` / `edit` / `mutating`.
 *
 * WHY `caution` AND NOT `destructive`. `destructive` is gated even under yolo
 * (`confirmDestructive`), which is the handling `bash` and `install` have earned
 * because one call of theirs can destroy work that exists outside this tool. The
 * blast radius here is one record the caller had to name AND quote, and an
 * unattended run whose memory contains something wrong should still be able to
 * take it out.
 *
 * WHY A `title` IS REQUIRED. `preview()` is handed only the arguments, so with
 * an id alone the permission prompt reads "forget a1b2c3d4" — a human is being
 * asked to approve the deletion of something they cannot see. Quoting the title
 * puts it in the prompt and makes the call self-checking: id and title must
 * describe the SAME record, so a transposed hex digit refuses instead of
 * deleting a bystander. This is `edit`'s `old_string` rule, applied to a store
 * where a bad match cannot be undone by editing it back.
 */
export function createForgetTool(store: MemoryStore): Tool {
  return {
    name: "forget",
    description:
      "Delete one wrong or unwanted fact from this project's persistent memory, addressed by " +
      "the id memory_search prints. Copy the stored title too — it is checked against the " +
      "record, so a mistyped id refuses rather than deleting something else. Not undoable.",
    usageHint:
      "Find the record first with memory_search or find_related_memories, then copy its id and " +
      "its title out of that output; a prefix of the id is enough as long as it is unambiguous. " +
      "Reach for this only when a fact is WRONG or the user asked you to forget it — when a " +
      "fact has merely gone out of date, `remember` the correction instead and leave the " +
      "history intact. A forgotten learning is gone from disk, not archived.",
    permission: "ask",
    category: "edit",
    mutating: true,
    riskTier: "caution",
    parameters: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Id from memory_search; an unambiguous prefix is enough.",
        },
        title: {
          type: "string",
          description: "The stored title, copied exactly. Must match the record `id` names.",
        },
      },
      required: ["id", "title"],
    },
    preview: (args) => `forget ${String(args.id)} "${String(args.title)}"`,
    async execute(args) {
      const id = requireString(args, "id").trim();
      const title = requireString(args, "title").trim();

      if (!store.remove) {
        return {
          output: `This memory store ("${store.id}") cannot forget: it is read-only.`,
          isError: true,
        };
      }

      const records = await store.all();
      if (records.length === 0) {
        return { output: "Project memory is empty — nothing to forget.", isError: true };
      }

      const found = resolveId(records, id);
      if (!found.ok) return lookupError(found, id);

      const record = found.record;
      if (!sameTitle(record.title, title)) {
        const head = `Refused: ${shortId(record)} is titled "${record.title}", not "${title}".`;
        return {
          output: `${head} Nothing was deleted — search again and copy both from one result.`,
          isError: true,
        };
      }

      // The echo is the only record of what was here: the line it describes no
      // longer exists anywhere, so a bare "done" would leave the session unable
      // to say what it deleted.
      const line = formatLearning(record);
      const removed = await store.remove(record.id);
      if (!removed) {
        return { output: `Nothing was removed for ${shortId(record)}.`, isError: true };
      }
      return { output: `Forgotten: ${line}` };
    },
  };
}

/**
 * `find_related_memories`: neighbours of a memory, or of a piece of text.
 *
 * Same corpus and same BM25 as `memory_search` (`rankMemories`) — the difference
 * is only where the query comes from. Anchored on an id, the record's OWN text
 * becomes the query, which is how it surfaces records that share a subject
 * without sharing the words the caller would have thought to search for.
 */
export function createRelatedMemoriesTool(store: MemoryStore): Tool {
  return {
    name: "find_related_memories",
    description:
      "Find memories related to an existing memory (pass its `id`) or to a piece of text " +
      "(pass `text`) — more-like-this over the same memory the search tool reads. The anchor " +
      "memory itself is never returned.",
    usageHint:
      "Anchor it on a memory_search hit to pull in the neighbours your search words missed: the " +
      "whole anchor record becomes the query, so it finds what shares a subject rather than what " +
      "shares your phrasing. With `text`, paste the actual thing you are working on — an error, " +
      "a plan, a file's purpose — rather than keywords; ranking is BM25 over the same corpus, so " +
      "more words is more signal here, not less. Passing both narrows the anchor in a direction.",
    // Without this the two memory-recall tools read as synonyms in the roster.
    selection: {
      doNotUseWhen: "you already have the words to search for",
      useInstead: "memory_search",
    },
    permission: "allow",
    category: "read",
    maxOutputBytes: 16_384,
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Anchor memory's id (a prefix is enough)." },
        text: { type: "string", description: "Text to relate against, instead of or with `id`." },
        limit: { type: "number", description: `Max results (default ${DEFAULT_LIMIT}).` },
      },
    },
    preview: (args) => {
      const id = typeof args.id === "string" && args.id.trim() ? args.id.trim() : "";
      const text = typeof args.text === "string" ? args.text.trim() : "";
      return `find_related_memories ${id || `"${text.slice(0, 40)}"`}`;
    },
    async execute(args) {
      const id = typeof args.id === "string" ? args.id.trim() : "";
      const text = typeof args.text === "string" ? args.text.trim() : "";
      if (!id && !text) {
        return {
          output: "Pass `id` (a memory to relate to), `text`, or both.",
          isError: true,
        };
      }

      const records = await store.all();
      if (records.length === 0) return { output: "Project memory is empty." };

      let anchor: MemoryRecord | undefined;
      if (id) {
        const found = resolveId(records, id);
        if (!found.ok) return lookupError(found, id);
        anchor = found.record;
      }
      const query = anchor ? `${text} ${learningText(anchor)}`.trim() : text;

      const hits = rankMemories(records, query, limitOf(args), anchor?.id);
      if (hits.length === 0) {
        return {
          output: anchor
            ? `Nothing else in memory relates to ${shortId(anchor)}.`
            : `Nothing in memory relates to "${text}".`,
        };
      }

      const lines = hits.map(formatLearning);
      // The anchor is echoed so the results have something to be "related" to:
      // the caller may be relating an id it read several turns ago.
      return {
        output: anchor
          ? [`Related to ${formatLearning(anchor)}:`, ...lines].join("\n")
          : lines.join("\n"),
      };
    },
  };
}
