import { randomUUID } from "node:crypto";
import type { AgentEvent, EventBus } from "./eventBus.js";
import type { LearningType, MemoryRecord, Observation } from "./memory.js";

/** Max characters kept per captured observation (keeps the digest prompt bounded). */
const OBS_TEXT_MAX = 600;
/** Max observations retained in the buffer (most recent win). */
const OBS_BUFFER_MAX = 120;

const LEARNING_TYPES: ReadonlySet<string> = new Set<LearningType>([
  "feature",
  "bugfix",
  "decision",
  "discovery",
  "note",
]);

/**
 * Buffers a session's tool activity from the event bus (Arterm's in-process
 * equivalent of claude-mem's PostToolUse hook). Nothing is persisted here; the
 * buffer is later compressed by `digest`.
 */
export class MemoryRecorder {
  private buffer: Observation[] = [];
  private off?: () => void;
  /** Observations captured since the last `clear()`. Drives periodic digesting. */
  private pending = 0;
  /** Fire `onFlush` once `pending` reaches this many (0 = disabled). */
  private threshold = 0;
  private onFlush?: () => void;
  /** Edge guard: only fire once per crossing, until the next `clear()`. */
  private flushRequested = false;

  /** Start listening on `bus`. Safe to call once; subsequent calls are no-ops. */
  attach(bus: EventBus): void {
    if (this.off) return;
    this.off = bus.on((e) => this.onEvent(e));
  }

  /** Stop listening. */
  detach(): void {
    this.off?.();
    this.off = undefined;
  }

  /**
   * Request a callback after every `threshold` newly-captured observations (the
   * claude-mem-style periodic digest trigger). `onFlush` fires once per crossing
   * and won't fire again until `clear()` resets the window. Pass threshold ≤ 0 to
   * disable. `onFlush` should kick off async work and return immediately.
   */
  setAutoFlush(threshold: number, onFlush: () => void): void {
    this.threshold = threshold;
    this.onFlush = onFlush;
  }

  private onEvent(e: AgentEvent): void {
    if (e.type === "tool_result") {
      // Skip empty / trivially-empty results.
      const text = e.output.trim();
      if (text) this.push({ source: "tool", label: e.name, text });
    } else if (e.type === "assistant_message") {
      const text = e.message.content.trim();
      if (text) this.push({ source: "assistant", label: "assistant", text });
    } else if (e.type === "goal_set") {
      this.push({ source: "user", label: "goal", text: e.goal });
    }
  }

  private push(obs: Observation): void {
    this.buffer.push({ ...obs, text: truncate(obs.text, OBS_TEXT_MAX) });
    if (this.buffer.length > OBS_BUFFER_MAX) {
      this.buffer.splice(0, this.buffer.length - OBS_BUFFER_MAX);
    }
    this.pending++;
    if (this.threshold > 0 && !this.flushRequested && this.pending >= this.threshold) {
      this.flushRequested = true;
      this.onFlush?.();
    }
  }

  /** The buffered observations in capture order. */
  observations(): Observation[] {
    return [...this.buffer];
  }

  /** Discard the buffer and reset the periodic-digest window (after a digest). */
  clear(): void {
    this.buffer = [];
    this.pending = 0;
    this.flushRequested = false;
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** A function that runs a prompt through a model and returns its text output. */
export type Summarizer = (prompt: string) => Promise<string>;

/**
 * Build the digest prompt fed to the summarizer sub-agent. Asks for a small set
 * of durable learnings in a strict, line-oriented format the parser understands.
 */
export function buildDigestPrompt(observations: Observation[]): string {
  const activity = observations
    .map((o, i) => `[${i + 1}] (${o.source}:${o.label}) ${o.text}`)
    .join("\n");
  return [
    "You are a memory compressor. Below is the activity log of a coding session: tool",
    "results and assistant messages. Extract the DURABLE facts worth remembering in a",
    "FUTURE session — decisions made, bugs fixed, features added, and non-obvious",
    "discoveries about this codebase. Ignore transient chatter and routine reads.",
    "",
    "Output ONLY learning lines, at most 8, each on its own line, in EXACTLY this format:",
    "LEARNING: <type> | <title> | <files> | <body>",
    "  - <type> is one of: feature, bugfix, decision, discovery, note",
    "  - <title> is a short one-line summary",
    "  - <files> is a comma-separated list of relevant file paths (or empty)",
    "  - <body> is one or two sentences of detail (or empty)",
    "If nothing is worth remembering, output exactly: NONE",
    "",
    "ACTIVITY LOG:",
    activity,
  ].join("\n");
}

/**
 * Parse the summarizer's output into memory records. Lenient: accepts any line
 * starting with "LEARNING:", tolerates missing trailing fields, and clamps an
 * unknown type to "note". Lines that aren't learnings are ignored.
 */
export function parseLearnings(text: string, now: number): MemoryRecord[] {
  const records: MemoryRecord[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    const match = /^LEARNING:\s*(.*)$/i.exec(line);
    if (!match) continue;
    const parts = (match[1] ?? "").split("|").map((p) => p.trim());
    const [typeRaw, title, filesRaw, body] = parts;
    if (!title) continue;
    const type: LearningType = LEARNING_TYPES.has((typeRaw ?? "").toLowerCase())
      ? ((typeRaw as string).toLowerCase() as LearningType)
      : "note";
    const files = (filesRaw ?? "")
      .split(",")
      .map((f) => f.trim())
      .filter((f) => f.length > 0);
    records.push({
      id: randomUUID(),
      kind: "learning",
      ts: now,
      type,
      title,
      ...(body ? { body } : {}),
      ...(files.length > 0 ? { files } : {}),
    });
  }
  return records;
}

/**
 * Compress buffered observations into learning records via `summarize`. Returns
 * an empty array (never throws) when there's nothing to digest or the model
 * produces no parseable learnings.
 */
export async function digest(
  observations: Observation[],
  summarize: Summarizer,
  now: number = Date.now(),
): Promise<MemoryRecord[]> {
  if (observations.length === 0) return [];
  try {
    const out = await summarize(buildDigestPrompt(observations));
    if (/^\s*NONE\s*$/i.test(out)) return [];
    return parseLearnings(out, now);
  } catch {
    return [];
  }
}

/** Format recent learnings as a system-prompt section (the claude-mem $CMEM block). */
export function formatMemorySection(records: MemoryRecord[]): string {
  if (records.length === 0) return "";
  const lines = records.map((r) => {
    const files = r.files && r.files.length > 0 ? ` (${r.files.join(", ")})` : "";
    return `- [${r.type}] ${r.title}${files}`;
  });
  return [
    "Project memory — durable facts learned in previous sessions (most recent last).",
    "Use these for continuity; call `memory_search` to recall more detail.",
    ...lines,
  ].join("\n");
}
