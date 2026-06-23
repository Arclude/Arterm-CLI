import { promises as fs } from "node:fs";
import type { CompactionResult, ContextStrategy } from "./contextStrategy.js";
import type { EventBus } from "./eventBus.js";
import type { PermissionManager } from "./permissions.js";
import { estimateHistoryTokens } from "./tokenEstimate.js";
import { parseToolCalls, toolSystemPrompt } from "./toolProtocol.js";
import type {
  ChatProvider,
  Message,
  PermissionAsker,
  SkillInfo,
  Tool,
  ToolCall,
  ToolSchema,
} from "./types.js";

export interface AgentOptions {
  provider: ChatProvider;
  model: string;
  tools: Tool[];
  permissions: PermissionManager;
  /** Invoked when a tool needs interactive approval. */
  ask: PermissionAsker;
  bus: EventBus;
  cwd: string;
  temperature?: number;
  /** Hard cap on tool-call round-trips per user turn. */
  maxIterations?: number;
  /** Base system prompt (agent persona). */
  systemPrompt?: string;
  /** Context-compaction strategy (defaults to no compaction). */
  context?: ContextStrategy;
  /** Model context window in tokens; drives auto-compaction. */
  contextWindow?: number;
  /** Compact automatically once usage crosses this fraction of the window. */
  compactAtPercent?: number;
  /** Invoked for every message appended to history (for incremental logging). */
  onMessage?: (message: Message) => void | Promise<void>;
  /** Skills advertised to the model in the system prompt (run via /skill). */
  skills?: SkillInfo[];
}

const DEFAULT_SYSTEM =
  "You are Arterm, a local AI coding agent running in the user's terminal. " +
  "You can read, search, and edit files and run shell commands via tools. " +
  "You are already running inside the user's project directory (shown below). " +
  "When the user refers to \"the project\", \"this project\", the README, or asks you to " +
  "inspect, read, summarize, or build on it, that means the working directory — " +
  "NEVER ask the user for the project location or a file path. Discover files yourself: " +
  "call the `ls` tool (its path defaults to the project root) and `read` the files you need, " +
  "then act. Do not describe what you would do or ask permission to start — just use the tools. " +
  "To CREATE or CHANGE a file you MUST call a tool: `write` to create a new file or fully " +
  "overwrite one (pass the complete content), or `edit` to replace specific text in an existing " +
  "file. Text you print in your reply is shown to the user but is NEVER saved to disk — so when " +
  "asked to create or update a file (e.g. write a README), call `write`/`edit` with the actual " +
  "content instead of pasting it into the chat. " +
  "Be concise. Prefer using tools over guessing. Always read a file before editing it.";

/** Directories that add noise to the project listing without helping the model. */
const LISTING_IGNORE = new Set([".git", "node_modules", ".DS_Store"]);

/** Top-level entries of `dir`, directories marked with a trailing slash. */
async function listProjectEntries(dir: string, limit = 200): Promise<string[]> {
  const dirents = await fs.readdir(dir, { withFileTypes: true });
  const names = dirents
    .filter((d) => !LISTING_IGNORE.has(d.name))
    .map((d) => (d.isDirectory() ? `${d.name}/` : d.name))
    .sort();
  if (names.length > limit) {
    return [...names.slice(0, limit), `… (+${names.length - limit} more)`];
  }
  return names;
}

/**
 * Drives the conversation: streams model output, executes tool calls (gated by
 * permissions), and feeds results back until the model produces a final answer.
 */
export class Agent {
  private messages: Message[] = [];
  private toolMap: Map<string, Tool>;
  /** Prompt tokens reported by the provider on the last turn (compaction signal). */
  private lastPromptTokens?: number;
  readonly bus: EventBus;

  constructor(private opts: AgentOptions) {
    this.bus = opts.bus;
    this.toolMap = new Map(opts.tools.map((t) => [t.name, t]));
  }

  get history(): readonly Message[] {
    return this.messages;
  }

  reset(): void {
    this.messages = [];
    this.lastPromptTokens = undefined;
  }

  get model(): string {
    return this.opts.model;
  }

  /** Switch the active model while preserving conversation history. */
  setModel(model: string): void {
    this.opts.model = model;
  }

  /** Switch the active backend while preserving conversation history. */
  setProvider(provider: ChatProvider): void {
    this.opts.provider = provider;
  }

  /** Wire (or rewire) the per-message persistence hook. */
  setOnMessage(onMessage: (message: Message) => void | Promise<void>): void {
    this.opts.onMessage = onMessage;
  }

  /** Advertise the available skills to the model (shown in the system prompt). */
  setSkills(skills: SkillInfo[]): void {
    this.opts.skills = skills;
  }

  /** Current tool set. */
  get tools(): Tool[] {
    return this.opts.tools;
  }

  /** Replace the tool set (used by the autonomy engine to inject `task_done`). */
  setTools(tools: Tool[]): void {
    this.opts.tools = tools;
    this.toolMap = new Map(tools.map((t) => [t.name, t]));
  }

  /**
   * One-shot completion-check over the current history, WITHOUT tools and WITHOUT
   * mutating history. Used by the autonomy engine to reflect on whether a goal is
   * done when the model didn't explicitly call `task_done`.
   */
  async assess(goal: string, signal?: AbortSignal): Promise<{ done: boolean; note: string }> {
    const { provider, model } = this.opts;
    const system = await this.buildSystem(true);
    const probe: Message = {
      role: "user",
      content:
        `GOAL: "${goal}"\nConsidering everything done so far, is the goal FULLY complete? ` +
        `Reply with exactly "DONE" if it is finished, otherwise "CONTINUE" and one line on the next step.`,
    };
    let text = "";
    for await (const chunk of provider.chat({
      model,
      messages: [system, ...this.messages, probe],
      temperature: 0,
      signal,
    })) {
      if (chunk.type === "text") text += chunk.delta;
    }
    const done = /\bDONE\b/i.test(text) && !/\bCONTINUE\b/i.test(text);
    return { done, note: text.trim().slice(0, 200) };
  }

  private toolSchemas(): ToolSchema[] {
    return this.opts.tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
  }

  private async buildSystem(native: boolean): Promise<Message> {
    const base = this.opts.systemPrompt ?? DEFAULT_SYSTEM;
    const env = await this.environmentPrompt();
    const toolHelp =
      native || this.opts.tools.length === 0 ? "" : `\n\n${toolSystemPrompt(this.toolSchemas())}`;
    return { role: "system", content: `${base}\n\n${env}${toolHelp}` };
  }

  /** Tells the model where it is and what's in the project root, so it can act
   * without asking the user for paths. */
  private async environmentPrompt(): Promise<string> {
    const lines = [`Working directory (the project root): ${this.opts.cwd}`];
    try {
      const entries = await listProjectEntries(this.opts.cwd);
      if (entries.length > 0) {
        lines.push("Top-level entries (paths are relative to the working directory):");
        lines.push(entries.join("\n"));
      }
    } catch {
      // If the directory can't be listed, the `ls` tool still works at call time.
    }
    const skills = this.opts.skills;
    if (skills && skills.length > 0) {
      lines.push("", "Available skills (the user can run one with /skill <name>):");
      lines.push(skills.map((s) => `- ${s.name}: ${s.description}`).join("\n"));
    }
    if (this.opts.permissions.getMode() === "plan") {
      lines.push(
        "",
        "PLAN MODE is active (read-only): do NOT call write, edit, or shell tools — they are " +
          "blocked. Only read and explore, then reply with a concise plan of the changes you " +
          "would make.",
      );
    }
    return lines.join("\n");
  }

  /** Runs one user turn to completion (possibly many tool round-trips). */
  async run(userInput: string, signal?: AbortSignal): Promise<void> {
    const { provider, model, tools } = this.opts;
    const native = tools.length > 0 ? await provider.supportsNativeTools(model) : false;
    const maxIterations = this.opts.maxIterations ?? 12;

    await this.record({ role: "user", content: userInput });
    this.bus.emit({ type: "turn_start" });

    try {
      for (let i = 0; i < maxIterations; i++) {
        if (signal?.aborted) break;
        if (this.shouldAutoCompact()) await this.compact("auto");

        const system = await this.buildSystem(native);
        const { text, calls } = await this.streamOnce(system, native, signal);

        const assistant: Message = { role: "assistant", content: text };
        if (calls.length > 0) assistant.toolCalls = calls;
        await this.record(assistant);
        this.bus.emit({ type: "assistant_message", message: assistant });

        if (calls.length === 0) break;

        for (const call of calls) {
          if (signal?.aborted) break;
          await this.runToolCall(call, signal);
        }
      }
    } catch (err) {
      this.bus.emit({ type: "error", error: err instanceof Error ? err.message : String(err) });
    } finally {
      this.bus.emit({ type: "turn_end" });
    }
  }

  private async streamOnce(
    system: Message,
    native: boolean,
    signal?: AbortSignal,
  ): Promise<{ text: string; calls: ToolCall[] }> {
    const { provider, model, tools, temperature } = this.opts;
    const calls: ToolCall[] = [];
    let text = "";

    const stream = provider.chat({
      model,
      messages: [system, ...this.messages],
      tools: native && tools.length > 0 ? this.toolSchemas() : undefined,
      temperature,
      signal,
    });

    for await (const chunk of stream) {
      if (chunk.type === "text") {
        text += chunk.delta;
        this.bus.emit({ type: "text_delta", delta: chunk.delta });
      } else if (chunk.type === "tool_call") {
        calls.push(chunk.call);
        this.bus.emit({ type: "tool_call", call: chunk.call });
      } else if (chunk.type === "done" && chunk.usage) {
        if (chunk.usage.promptTokens !== undefined) this.lastPromptTokens = chunk.usage.promptTokens;
        this.bus.emit({ type: "usage", usage: chunk.usage });
      }
    }

    // Fallback path: recover tool calls from the text body.
    if (!native && tools.length > 0) {
      const parsed = parseToolCalls(text);
      if (parsed.calls.length > 0) {
        text = parsed.cleaned;
        for (const call of parsed.calls) {
          calls.push(call);
          this.bus.emit({ type: "tool_call", call });
        }
      }
    }

    return { text, calls };
  }

  private async runToolCall(call: ToolCall, signal?: AbortSignal): Promise<void> {
    const tool = this.toolMap.get(call.name);
    if (!tool) {
      await this.pushToolResult(call, `Unknown tool: ${call.name}`, true);
      return;
    }

    const decision = await this.opts.permissions.check(tool, call.arguments, this.opts.ask);
    if (!decision.allowed) {
      this.bus.emit({ type: "tool_denied", callId: call.id, name: call.name });
      await this.pushToolResult(
        call,
        decision.reason ?? "Tool call denied by the user.",
        true,
      );
      return;
    }

    try {
      const result = await tool.execute(call.arguments, { cwd: this.opts.cwd, signal });
      await this.pushToolResult(call, result.output, result.isError ?? false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.pushToolResult(call, `Tool error: ${msg}`, true);
    }
  }

  private async pushToolResult(call: ToolCall, output: string, isError: boolean): Promise<void> {
    await this.record({
      role: "tool",
      content: output,
      toolCallId: call.id,
      name: call.name,
    });
    this.bus.emit({ type: "tool_result", callId: call.id, name: call.name, output, isError });
  }

  /** Append a message to history and notify the persistence hook. */
  private async record(message: Message): Promise<void> {
    this.messages.push(message);
    if (this.opts.onMessage) await this.opts.onMessage(message);
  }

  /** True when the working history is close enough to the context window to compact. */
  private shouldAutoCompact(): boolean {
    const window = this.opts.contextWindow;
    const strategy = this.opts.context;
    if (!window || !strategy || strategy.id === "none") return false;
    const used = this.lastPromptTokens ?? estimateHistoryTokens(this.messages);
    return used >= (this.opts.compactAtPercent ?? 0.85) * window;
  }

  /**
   * Compact the in-memory working history using the configured strategy. The
   * on-disk transcript is unaffected (messages were logged as they were produced).
   * Returns counts even when nothing changed.
   */
  async compact(reason: "auto" | "manual" = "manual"): Promise<CompactionResult> {
    const before = this.messages.length;
    const strategy = this.opts.context;
    if (!strategy) return { messages: this.messages, before, after: before };

    const result = await strategy.compact(this.messages, {
      estimatedTokens: estimateHistoryTokens(this.messages),
      model: this.opts.model,
      reason,
    });
    this.messages = result.messages;
    if (result.after !== result.before) {
      this.lastPromptTokens = undefined; // stale; recompute next turn
      this.bus.emit({
        type: "context_compacted",
        before: result.before,
        after: result.after,
        reason,
      });
    }
    return result;
  }
}
