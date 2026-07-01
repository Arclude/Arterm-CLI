/**
 * `@arterm/memory` — a fuller claude-mem clone for Arterm-CLI: rich, typed
 * observations captured off the event bus, compressed by an observer LLM, stored
 * in SQLite (FTS5) or an in-memory/JSONL fallback, and recalled via a compact
 * progressive-disclosure legend plus semantic + lexical search tools. Opt-in and
 * parallel to the legacy `@arterm/core` memory system (selected in the CLI).
 */

export * from "./types.js";
export * from "./store.js";
export * from "./mode.js";
export * from "./embedder.js";
export * from "./bm25.js";
export * from "./search.js";
export * from "./recall.js";
export * from "./observer.js";
export * from "./tools.js";
export * from "./engine.js";
export * from "./mcpServer.js";
