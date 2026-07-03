import { promises as fs } from "node:fs";
import type { CompactionResult, ContextStrategy } from "./contextStrategy.js";
import type { EventBus } from "./eventBus.js";
import {
  Container,
  type PipelineRegistry,
  RunController,
  Tokens,
  createPipelines,
} from "./kernel/index.js";
import { modelContextWindow } from "./modelsDev.js";
import type { PermissionManager } from "./permissions.js";
import { estimateHistoryTokens } from "./tokenEstimate.js";
import { parseToolCalls, toolSystemPrompt } from "./toolProtocol.js";
import type {
  ChatProvider,
  DiffRow,
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
  /** Seed the conversation with prior messages (e.g. resuming a recorded session). */
  initialMessages?: Message[];
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
  /**
   * Returns a "project memory" section to inject into the system prompt (durable
   * facts from previous sessions). Invoked fresh each turn; return "" for none.
   */
  recall?: () => Promise<string> | string;
  /**
   * Kernel DI container for this agent's run-scoped services (today: the
   * RunController that owns each turn's lifecycle). The session supplies its root
   * container so the agent shares the same graph; agents constructed standalone
   * (sub-agents, tests) get an internal default — so this is always optional.
   */
  container?: Container;
}

/** The internal container for a standalone agent — binds just what `run()` needs. */
function defaultAgentContainer(): Container {
  const c = new Container();
  c.bind(Tokens.Pipelines, () => createPipelines());
  c.bind(Tokens.RunController, () => new RunController(c));
  return c;
}

const DEFAULT_SYSTEM =
  "You are Arterm, a local AI coding agent running in the user's terminal. " +
  "You can read, search, and edit files and run shell commands via tools. " +
  "You are already running inside the user's project directory (shown below). " +
  'When the user refers to "the project", "this project", the README, or asks you to ' +
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
 *
 * The loop's seams run on the kernel: a `RunController` owns each turn's cancellation
 * signal + teardown, and the loop's behavior is composed from named middleware stages on
 * the `userInput`/`request`/`response`/`assistantOutput`/`toolCall`/`contextWindow`
 * pipelines (installed by `installDefaultPipelines()`). To change loop behavior, add or
 * replace a stage rather than editing `run()` — see CLAUDE.md "Kernel".
 */
export class Agent {
  private messages: Message[] = [];
  private toolMap: Map<string, Tool>;
  /** Prompt tokens reported by the provider on the last turn (compaction signal). */
  private lastPromptTokens?: number;
  readonly bus: EventBus;
  /** Per-agent kernel container (session-supplied or an internal default). */
  private readonly container: Container;
  /** Owns each turn's cancellation signal + teardown; resolved from the container. */
  private readonly runController: RunController;
  /** Named middleware chains around the loop seams; resolved from the container. */
  private readonly pipelines: PipelineRegistry;

  constructor(private opts: AgentOptions) {
    this.bus = opts.bus;
    if (opts.initialMessages?.length) this.messages = [...opts.initialMessages];
    this.toolMap = new Map(opts.tools.map((t) => [t.name, t]));
    this.container = opts.container ?? defaultAgentContainer();
    this.runController = this.container.resolve(Tokens.RunController);
    this.pipelines = this.container.resolve(Tokens.Pipelines);
    this.installDefaultPipelines();
  }

  /**
   * Install this agent's built-in pipeline stages, skipping any a feature (or test)
   * already registered on the shared container under the same name — so the default
   * behavior is overridable without rewriting the loop. Today: the `autoCompact` stage
   * on `contextWindow`, which holds the threshold check the loop used to inline.
   */
  private installDefaultPipelines(): void {
    const cw = this.pipelines.contextWindow;
    if (!cw.has("autoCompact")) {
      cw.use("autoCompact", async (ctx, next) => {
        if (this.shouldAutoCompact()) {
          const result = await this.compact("auto");
          ctx.before = result.before;
          ctx.after = result.after;
          ctx.messages = result.messages;
        }
        await next();
      });
    }

    const tc = this.pipelines.toolCall;
    if (!tc.has("permission")) {
      // Resolve the tool and gate it. An unknown name or a denied decision short-circuits
      // (no `next()`), leaving an error in `ctx` for the loop to record. This is the seam
      // where the Brain Arbiter / risk-tier checks slot in as additional middleware.
      tc.use("permission", async (ctx, next) => {
        const tool = this.toolMap.get(ctx.call.name);
        if (!tool) {
          ctx.output = `Unknown tool: ${ctx.call.name}`;
          ctx.isError = true;
          return;
        }
        const decision = await this.opts.permissions.check(tool, ctx.call.arguments, this.opts.ask);
        if (!decision.allowed) {
          this.bus.emit({
            type: "tool_denied",
            callId: ctx.call.id,
            name: ctx.call.name,
            reason: decision.reason,
          });
          ctx.output = decision.reason ?? "Tool call denied by the user.";
          ctx.isError = true;
          return;
        }
        ctx.tool = tool;
        await next();
      });
    }
    if (!tc.has("execute")) {
      tc.use("execute", async (ctx, next) => {
        if (!ctx.tool) return; // gated out upstream
        try {
          const result = await ctx.tool.execute(ctx.call.arguments, {
            cwd: this.opts.cwd,
            signal: ctx.signal,
            tools: this.opts.tools,
          });
          ctx.output = result.output;
          ctx.isError = result.isError ?? false;
          ctx.diff = result.diff;
          ctx.path = result.path;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          ctx.output = `Tool error: ${msg}`;
          ctx.isError = true;
        }
        await next();
      });
    }

    const ui = this.pipelines.userInput;
    if (!ui.has("record")) {
      ui.use("record", async (ctx, next) => {
        await this.record({ role: "user", content: ctx.input });
        await next();
      });
    }

    const req = this.pipelines.request;
    if (!req.has("buildSystem")) {
      req.use("buildSystem", async (ctx, next) => {
        ctx.system = await this.buildSystem(ctx.native);
        await next();
      });
    }

    const res = this.pipelines.response;
    if (!res.has("recoverToolCalls")) {
      // Tool-call fallback: when the provider yielded no native calls, recover JSON tool
      // calls from the text body (non-native models, and native ones that emit the call as
      // text). Emits a tool_call event per recovered call, exactly as the stream path did.
      res.use("recoverToolCalls", async (ctx, next) => {
        if (this.opts.tools.length > 0 && ctx.calls.length === 0) {
          const parsed = parseToolCalls(ctx.text);
          if (parsed.calls.length > 0) {
            ctx.text = parsed.cleaned;
            for (const call of parsed.calls) {
              ctx.calls.push(call);
              this.bus.emit({ type: "tool_call", call });
            }
          }
        }
        await next();
      });
    }

    const ao = this.pipelines.assistantOutput;
    if (!ao.has("record")) {
      ao.use("record", async (ctx, next) => {
        await this.record(ctx.message);
        this.bus.emit({ type: "assistant_message", message: ctx.message });
        await next();
      });
    }
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

  /**
   * The active model's real context window: the models.dev catalog value for the
   * current provider/model when known (e.g. 200k/1M for Claude), else the
   * configured fallback. Used for both the auto-compaction threshold and the TUI
   * gauge so they track whatever model is selected rather than a static default.
   */
  effectiveContextWindow(): number | undefined {
    return modelContextWindow(this.opts.model, this.opts.provider.id) ?? this.opts.contextWindow;
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
      content: `GOAL: "${goal}"\nConsidering everything done so far, is the goal FULLY complete? Reply with exactly "DONE" if it is finished, otherwise "CONTINUE" and one line on the next step.`,
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

  /**
   * One-shot planning probe over the current history, WITHOUT tools and WITHOUT
   * mutating history. Returns the model's raw text. Used by parallel autonomy to ask
   * the leader to decompose the goal into independent subtasks.
   */
  async plan(prompt: string, signal?: AbortSignal): Promise<string> {
    const { provider, model } = this.opts;
    const system = await this.buildSystem(true);
    const probe: Message = { role: "user", content: prompt };
    let text = "";
    for await (const chunk of provider.chat({
      model,
      messages: [system, ...this.messages, probe],
      temperature: 0,
      signal,
    })) {
      if (chunk.type === "text") text += chunk.delta;
    }
    return text.trim();
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
    let toolHelp = "";
    if (this.opts.tools.length > 0) {
      if (native) {
        // Native models get tool schemas via the API, so we don't inject the JSON
        // protocol. But small local models (e.g. qwen on Ollama) emit calls as TEXT
        // and readily INVENT tool names (`count`, `length`, …) that don't exist.
        // Listing the real tools and forbidding others curbs those hallucinated calls.
        const roster = this.toolSchemas()
          .map((t) => `- ${t.name}: ${t.description}`)
          .join("\n");
        toolHelp = `\n\nThese are the ONLY tools that exist — use exactly these names and never invent a tool. Call one tool at a time and wait for its result:\n${roster}`;
      } else {
        toolHelp = `\n\n${toolSystemPrompt(this.toolSchemas())}`;
      }
    }
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
    if (this.opts.recall) {
      try {
        const memory = (await this.opts.recall()).trim();
        if (memory) lines.push("", memory);
      } catch {
        // Memory recall must never break a turn.
      }
    }
    return lines.join("\n");
  }

  /** Runs one user turn to completion (possibly many tool round-trips). */
  async run(userInput: string, signal?: AbortSignal): Promise<void> {
    const { provider, model, tools } = this.opts;
    const native = tools.length > 0 ? await provider.supportsNativeTools(model) : false;
    const maxIterations = this.opts.maxIterations ?? 12;

    // The RunController owns this turn's lifecycle: one cancellation signal + LIFO
    // teardown. The caller's `signal` (TUI Esc, autonomy pause/stop) is LINKED into
    // the handle rather than threaded directly, so cancellation has a single source
    // of truth while the public `run(input, signal?)` contract is unchanged.
    const handle = this.runController.begin();
    handle.iterationLimit(maxIterations);
    const onExternalAbort = () => handle.abort("external");
    if (signal) {
      if (signal.aborted) handle.abort("external");
      else signal.addEventListener("abort", onExternalAbort, { once: true });
    }
    const runSignal = handle.signal;
    handle.onTeardown(() => this.bus.emit({ type: "turn_end" }));

    await this.pipelines.userInput.run({ input: userInput });
    this.bus.emit({ type: "turn_start" });

    try {
      const limit = handle.getIterationLimit() ?? maxIterations;
      for (let i = 0; i < limit; i++) {
        if (runSignal.aborted) break;
        // Auto-compaction runs as the `contextWindow` pipeline's default stage, so the
        // threshold policy is swappable without touching the loop.
        await this.pipelines.contextWindow.run({ messages: this.messages, reason: "auto" });

        // request → assemble the prompt (default stage builds the system message);
        // streamRaw → call the provider; response → post-process (recovers JSON tool
        // calls when none came natively); assistantOutput → record + announce the reply.
        const request = await this.pipelines.request.run({
          system: { role: "system", content: "" },
          messages: this.messages,
          native,
        });
        const raw = await this.streamRaw(request.system, request.messages, native, runSignal);
        const response = await this.pipelines.response.run({ text: raw.text, calls: raw.calls });

        const assistant: Message = { role: "assistant", content: response.text };
        if (response.calls.length > 0) assistant.toolCalls = response.calls;
        await this.pipelines.assistantOutput.run({ message: assistant });

        if (response.calls.length === 0) break;

        for (const call of response.calls) {
          // An abort mid-turn must still leave a tool result for every recorded
          // tool_call — otherwise the next turn's history has an assistant tool_call
          // with no matching tool message, which native provider APIs reject.
          if (runSignal.aborted) {
            await this.pushToolResult(call, "Tool call cancelled by the user.", true);
            continue;
          }
          await this.runToolCall(call, runSignal);
        }
      }
    } catch (err) {
      this.bus.emit({ type: "error", error: err instanceof Error ? err.message : String(err) });
    } finally {
      if (signal) signal.removeEventListener("abort", onExternalAbort);
      // Teardown (LIFO) runs the turn_end emit; idempotent and never throws.
      await handle.finish();
    }
  }

  /**
   * Stream one model response: collect native text + tool calls and emit the
   * text_delta / tool_call / usage events. The bare-JSON tool-call fallback now lives in
   * the `response` pipeline's `recoverToolCalls` stage, not here.
   */
  private async streamRaw(
    system: Message,
    messages: Message[],
    native: boolean,
    signal?: AbortSignal,
  ): Promise<{ text: string; calls: ToolCall[] }> {
    const { provider, model, tools, temperature } = this.opts;
    const calls: ToolCall[] = [];
    let text = "";

    const stream = provider.chat({
      model,
      messages: [system, ...messages],
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
        if (chunk.usage.promptTokens !== undefined)
          this.lastPromptTokens = chunk.usage.promptTokens;
        this.bus.emit({ type: "usage", usage: chunk.usage });
      }
    }

    return { text, calls };
  }

  private async runToolCall(call: ToolCall, signal?: AbortSignal): Promise<void> {
    // Permission-check and execution live in the `toolCall` pipeline (default stages
    // `permission` + `execute`); the agent owns only recording the outcome back into
    // history, so a feature can re-gate or wrap execution without touching this method.
    const ctx = await this.pipelines.toolCall.run({ call, signal });
    await this.pushToolResult(call, ctx.output ?? "", ctx.isError ?? false, ctx.diff, ctx.path);
  }

  private async pushToolResult(
    call: ToolCall,
    output: string,
    isError: boolean,
    diff?: DiffRow[],
    path?: string,
  ): Promise<void> {
    await this.record({
      role: "tool",
      content: output,
      toolCallId: call.id,
      name: call.name,
    });
    this.bus.emit({
      type: "tool_result",
      callId: call.id,
      name: call.name,
      output,
      isError,
      diff,
      path,
    });
  }

  /** Append a message to history and notify the persistence hook. */
  private async record(message: Message): Promise<void> {
    this.messages.push(message);
    if (this.opts.onMessage) await this.opts.onMessage(message);
  }

  /** True when the working history is close enough to the context window to compact. */
  private shouldAutoCompact(): boolean {
    const window = this.effectiveContextWindow();
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
