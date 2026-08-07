import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { RunBudget } from "./budget.js";
import type { CompactionResult, ContextStrategy } from "./contextStrategy.js";
import type { CredentialSettings } from "./credentials.js";
import type { EventBus } from "./eventBus.js";
import {
  Container,
  type PipelineRegistry,
  RunController,
  Tokens,
  createPipelines,
} from "./kernel/index.js";
import { type LoopDetectOptions, type LoopDetector, createLoopDetector } from "./loopDetector.js";
import { modelContextWindow } from "./modelsDev.js";
import type { PermissionManager } from "./permissions.js";
import type { ProcessRegistry } from "./processRegistry.js";
import { ProviderError } from "./providerError.js";
import type { SandboxRunner } from "./sandbox.js";
import { estimateHistoryTokens, estimateMessageTokens, estimateTokens } from "./tokenEstimate.js";
import { DEFAULT_MAX_OUTPUT_BYTES, clampMiddle, spoolOutput } from "./toolOutput.js";
import { parseToolCalls, toolSystemPrompt } from "./toolProtocol.js";
import type {
  ChatProvider,
  DiffRow,
  Message,
  PermissionAsker,
  SkillInfo,
  TokenUsage,
  Tool,
  ToolCall,
  ToolSchema,
} from "./types.js";

/**
 * The context's composition, in estimated tokens. See {@link Agent.contextBreakdown}
 * for why these are estimates and why `total` is not `contextUsage().used`.
 */
export interface ContextBreakdown {
  /** The system message as sent: base prompt, project instructions, skills. */
  system: number;
  /**
   * Tool schemas sent through the API's own field. Zero for a model without
   * native tool-calling — there the schemas are part of `system`, and counting
   * them twice would inflate the only number a reader can act on.
   */
  tools: number;
  /** User and assistant turns. */
  conversation: number;
  /** Tool results still in the working history. */
  toolResults: number;
  /** The parts, summed. An estimate; see the method's note. */
  total: number;
  /** Messages in the working history. */
  messages: number;
  /** Whether the model takes tool schemas through the API rather than the prompt. */
  nativeTools: boolean;
}

export interface AgentOptions {
  provider: ChatProvider;
  model: string;
  tools: Tool[];
  permissions: PermissionManager;
  /** Invoked when a tool needs interactive approval. */
  ask: PermissionAsker;
  bus: EventBus;
  cwd: string;
  /**
   * Execution boundary for shell commands (see `sandbox.ts`). Passed straight
   * through to every tool's `ToolContext`; only `bash` consumes it today. Shared
   * with sub-agents, because a fleet worker running unconfined is the same host
   * with more concurrency.
   */
  sandbox?: SandboxRunner;
  /**
   * Env hygiene for shell commands (see `credentials.ts`). Shared with
   * sub-agents for the same reason the sandbox is: a fleet worker's `bash` is
   * the same shell on the same host, and it feeds the same transcript.
   */
  credentials?: CredentialSettings;
  /**
   * Where a detached child is recorded. Passed down to sub-agents unchanged for
   * the same reason as the sandbox: a worker that backgrounds a process the
   * parent's teardown cannot see leaves it running after the session ends.
   */
  processes?: ProcessRegistry;
  /** Seed the conversation with prior messages (e.g. resuming a recorded session). */
  initialMessages?: Message[];
  temperature?: number;
  /** Hard cap on tool-call round-trips per user turn. */
  maxIterations?: number;
  /**
   * Token budget per turn: summed prompt+completion tokens across the turn's
   * iterations (each iteration re-bills the prompt, so the sum is the real
   * spend). Crossing it stops the loop and emits a `run_limit` event.
   */
  turnTokenBudget?: number;
  /** Replace stale tool outputs with placeholders before compaction (default true). */
  clearToolResults?: boolean;
  /** Clear stale tool results once usage crosses this fraction of the window (default 0.6). */
  clearAtPercent?: number;
  /** Never clear the newest N tool results (default 3). */
  keepRecentToolResults?: number;
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
  /**
   * Loop/stuck detector thresholds (see `loopDetector.ts`). On by default;
   * `{ enabled: false }` drops both stages entirely.
   */
  loopDetect?: LoopDetectOptions;
  /**
   * The run's spend counter (see `budget.ts`). Shared with sub-agents by
   * default, so a fleet's tokens roll up into the parent's ceiling.
   */
  budget?: RunBudget;
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

/**
 * Project instruction files loaded up-front, first match wins. Small and eager
 * (the Claude Code / AGENTS.md pattern): instructions belong in context from
 * turn one, while file CONTENTS stay just-in-time via the read/grep tools.
 */
const INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md", "ARTERM.md"];

/** Character cap for injected project instructions — oversized files lose the
 * model's attention (context rot), so the tail is dropped, not summarized. */
const INSTRUCTIONS_MAX_CHARS = 6000;

/** First existing instruction file in `dir` (name + capped body), if any. */
async function loadProjectInstructions(
  dir: string,
): Promise<{ name: string; body: string } | undefined> {
  for (const name of INSTRUCTION_FILES) {
    try {
      const raw = (await fs.readFile(join(dir, name), "utf8")).trim();
      if (!raw) continue;
      const body =
        raw.length > INSTRUCTIONS_MAX_CHARS
          ? `${raw.slice(0, INSTRUCTIONS_MAX_CHARS)}\n… (${name} truncated — read the file for the rest)`
          : raw;
      return { name, body };
    } catch {
      // Missing or unreadable — try the next candidate.
    }
  }
  return undefined;
}

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
  /** Tools whose `usageHint` has already been delivered — once per session. */
  private readonly hintedTools = new Set<string>();
  /** Loop-guard state, reset each run(): consecutive same-error streaks per tool. */
  private failStreaks = new Map<string, { sig: string; count: number }>();
  /** Loop/stuck detector (steer-then-cut); its fingerprint state outlives turns. */
  private loopDetector?: LoopDetector;
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
    if (!cw.has("clearToolResults")) {
      // First line of context defense (registered before autoCompact so it runs
      // first): stale tool outputs are re-fetchable, so once usage crosses the
      // clear threshold they become placeholders. Zero inference cost, and the
      // tool-message structure survives (native APIs keep their call pairing).
      // The on-disk transcript is untouched — messages were logged when recorded.
      cw.use("clearToolResults", async (ctx, next) => {
        if (this.shouldClearToolResults()) {
          const cleared = this.clearStaleToolResults();
          if (cleared > 0) this.bus.emit({ type: "tool_results_cleared", cleared });
        }
        await next();
      });
    }
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
          // Name the real roster: small local models often guess names like
          // read_file/search — a corrective list lets them recover instead of
          // spiraling through more invented tools.
          ctx.output = `Unknown tool: ${ctx.call.name}. Valid tools: ${[...this.toolMap.keys()].join(", ")}`;
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
            ...(this.opts.sandbox ? { sandbox: this.opts.sandbox } : {}),
            ...(this.opts.credentials ? { credentials: this.opts.credentials } : {}),
            ...(this.opts.processes ? { processes: this.opts.processes } : {}),
          });
          // The ceiling, enforced where every tool passes rather than inside
          // each one. A tool with an opinion sets `maxOutputBytes`; everything
          // else — including MCP and plugin tools, written by someone else and
          // capped at nothing — gets the backstop. What is cut is spooled, so
          // the model can grep the file instead of re-running the command.
          const cap = ctx.tool.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
          const clamped = clampMiddle(result.output, cap);
          if (clamped.truncated) {
            const file = await spoolOutput(result.output, ctx.tool.name);
            ctx.output = file
              ? `${clamped.text}\n[full output: ${file}]`
              : `${clamped.text}\n[full output was ${clamped.originalBytes} bytes]`;
          } else {
            ctx.output = result.output;
          }
          ctx.isError = result.isError ?? false;
          ctx.diff = result.diff;
          ctx.path = result.path;
          // `usageHint` is delivered here rather than in the roster: the roster
          // is paid for on every request, so a paragraph per tool would cost
          // far more than it teaches. Attached to the first FAILED call, it
          // arrives at the moment it is needed — and once, because a hint
          // repeated on every failure is just a longer error.
          if (ctx.isError && ctx.tool.usageHint && !this.hintedTools.has(ctx.tool.name)) {
            this.hintedTools.add(ctx.tool.name);
            ctx.output = `${ctx.output}\n\nHow to use ${ctx.tool.name}: ${ctx.tool.usageHint}`;
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          ctx.output = `Tool error: ${msg}`;
          ctx.isError = true;
        }
        await next();
      });
    }
    if (!tc.has("loopGuard")) {
      // Runs after `execute` (registration order). Guards against silent
      // error-compounding: the same tool failing repeatedly with the same error
      // appends a corrective note to the tool result — small local models escape
      // these loops only when the failure is named explicitly. (Identical-call
      // repetition moved to the loop detector's sliding-window stage below,
      // which also catches A-B-A-B alternation.)
      tc.use("loopGuard", async (ctx, next) => {
        if (ctx.isError) {
          const sig = (ctx.output ?? "").slice(0, 160);
          const prev = this.failStreaks.get(ctx.call.name);
          const count = prev && prev.sig === sig ? prev.count + 1 : 1;
          this.failStreaks.set(ctx.call.name, { sig, count });
          if (count >= 2) {
            ctx.output = `${ctx.output}\n\n[loop-guard] ${ctx.call.name} has now failed ${count}x in a row with the same error. Do not repeat the call unchanged — fix the arguments, use a different tool, or tell the user what is blocking you.`;
          }
        } else {
          this.failStreaks.delete(ctx.call.name);
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
    const budget = this.opts.budget;
    if (budget && !budget.inactive && !req.has("budgetGate")) {
      // Registered BEFORE buildSystem so a breach costs nothing: the check is
      // pre-spend, at the request boundary. Gating mid-tool would throw away
      // the work the tool just did, and throwing mid-turn would drop the
      // assistant message about to land — so this short-circuits the chain
      // (no `next()`) and lets the loop end the turn normally.
      req.use("budgetGate", async (ctx, next) => {
        if (budget.breached) {
          ctx.refused = `run budget spent (${budget.describe()})`;
          this.bus.emit({ type: "budget_exceeded", spent: budget.describe() });
          return;
        }
        await next();
      });
    }

    if (!req.has("buildSystem")) {
      req.use("buildSystem", async (ctx, next) => {
        ctx.system = await this.buildSystem(ctx.native);
        await next();
      });
    }

    const res = this.pipelines.response;
    if (budget && !res.has("budgetMeter")) {
      // Meter from the provider's OWN usage, never from an estimate: every
      // iteration resends the history, so estimating from the message list
      // double-counts the whole conversation on each lap. A soft crossing is
      // announced once and turned into a wrap-up instruction by the autonomy
      // engine — the run is asked to finish, not cut off mid-thought.
      //
      // Installed whether or not a ceiling is configured. It used to be gated
      // on `!budget.inactive`, which made spend accounting a side effect of
      // having set a limit: every run without `--max-usd` reported zero tokens
      // and zero cost, indistinguishable from a backend that counts nothing.
      // Reporting is not conditional on limiting, and the cost of being right
      // is one memoized catalog lookup per response. `takeSoftSignal()` is
      // already a no-op with no ceiling, so nothing else changes.
      res.use("budgetMeter", async (ctx, next) => {
        if (ctx.usage) budget.spend(ctx.usage, this.opts.model, this.opts.provider.id);
        if (budget.takeSoftSignal()) {
          this.bus.emit({ type: "budget_warning", spent: budget.describe() });
        }
        await next();
      });
    }
    if (!res.has("recoverToolCalls")) {
      // Tool-call fallback: when the provider yielded no native calls, recover JSON tool
      // calls from the text body (non-native models, and native ones that emit the call as
      // text). Emits a tool_call event per recovered call, exactly as the stream path did.
      res.use("recoverToolCalls", async (ctx, next) => {
        if (this.opts.tools.length > 0 && ctx.calls.length === 0) {
          const parsed = parseToolCalls(ctx.text, new Set(this.opts.tools.map((t) => t.name)));
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

    // Loop/stuck detector: registered last so the response stage sees calls that
    // `recoverToolCalls` recovered from text, and the toolCall stage sees the
    // final output `loopGuard` produced. Both halves share one closure, so the
    // detector is created once per agent and its fingerprint state outlives
    // individual turns — repetition ACROSS eternal-mode steps is the target.
    if (this.opts.loopDetect?.enabled !== false) {
      const det = createLoopDetector({ ...this.opts.loopDetect, bus: this.bus });
      this.loopDetector = det;
      if (!res.has("loopDetector")) res.use("loopDetector", det.responseStage);
      if (!tc.has("repeatWindow")) tc.use("repeatWindow", det.toolCallStage);
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
    const probe: Message = {
      role: "user",
      content: `GOAL: "${goal}"\nConsidering everything done so far, is the goal FULLY complete? Reply with exactly "DONE" if it is finished, otherwise "CONTINUE" and one line on the next step.`,
    };
    let text = "";
    try {
      const system = await this.buildSystem(true);
      for await (const chunk of provider.chat({
        model,
        messages: [system, ...this.messages, probe],
        temperature: 0,
        signal,
      })) {
        if (chunk.type === "text") text += chunk.delta;
      }
    } catch (err) {
      // The autonomy loop calls assess() fire-and-forget; a provider/network failure
      // must not become an unhandled rejection. Treat it as "not done" so the loop's
      // idle-streak logic keeps control and can eventually stop.
      const msg = err instanceof Error ? err.message : String(err);
      return { done: false, note: `assessment failed: ${msg}` };
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
    const probe: Message = { role: "user", content: prompt };
    let text = "";
    try {
      const system = await this.planSystem();
      for await (const chunk of provider.chat({
        model,
        messages: [system, ...this.messages, probe],
        temperature: 0,
        signal,
      })) {
        if (chunk.type === "text") text += chunk.delta;
      }
    } catch {
      // Leader decomposition is best-effort; on failure return an empty plan so the
      // tolerant parsers (parseTasks/parsePhases) fall back to running the goal whole.
      return "";
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

  /**
   * System prompt for the tool-free {@link plan} probe — deliberately NOT
   * `buildSystem()`.
   *
   * That one tells the model it is an agent with tools and to act rather than
   * describe, while `plan()` passes no `tools` at all. A capable model resolves
   * that contradiction by NARRATING the call it cannot make — a real run against
   * Opus answered a "write a spec and a task graph" probe with "Let me inspect
   * the log file first. **Tool: read**". That parses as neither, so every caller
   * fell back to its tolerant path: /sdd ran the whole brief as one task with a
   * garbage spec, and reported success. Silent, and invisible to a small local
   * model, which is what this was built against.
   */
  private async planSystem(): Promise<Message> {
    const env = await this.environmentPrompt();
    return {
      role: "system",
      content: `You are the planning half of a coding agent. In THIS turn you have no tools and cannot read files or run commands — do not call, request, or narrate a tool call, and do not say what you would inspect first. Answer from the question and the project layout below. When the question specifies a reply format, emit exactly that and nothing else.\n\n${env}`,
    };
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
        // The roster line carries `selection` when a tool has one: this is the
        // one place a model is choosing BETWEEN tools, and without it `grep`
        // and `search` read as synonyms.
        const roster = this.opts.tools
          .map((t) => {
            const pick = t.selection
              ? ` (not for ${t.selection.doNotUseWhen} — use ${t.selection.useInstead})`
              : "";
            return `- ${t.name}: ${t.description}${pick}`;
          })
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
    const instructions = await loadProjectInstructions(this.opts.cwd);
    if (instructions) {
      lines.push(
        "",
        `Project instructions from ${instructions.name} (follow these):`,
        instructions.body,
      );
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
    this.failStreaks = new Map();
    // Per-turn half only — the iteration-fingerprint streak survives on purpose.
    this.loopDetector?.resetTurn();
    const onExternalAbort = () => handle.abort("external");
    if (signal) {
      if (signal.aborted) handle.abort("external");
      else signal.addEventListener("abort", onExternalAbort, { once: true });
    }
    const runSignal = handle.signal;
    handle.onTeardown(() => this.bus.emit({ type: "turn_end" }));

    try {
      // userInput.run persists the user message (record → onMessage → transcript
      // append). Keep it INSIDE the try so a failed write (disk full, EACCES, path
      // limit) surfaces as an `error` event and still runs teardown (turn_end),
      // instead of rejecting run() and leaking the turn.
      await this.pipelines.userInput.run({ input: userInput });
      this.bus.emit({ type: "turn_start" });

      const limit = handle.getIterationLimit() ?? maxIterations;
      const budget = this.opts.turnTokenBudget;
      let usedTokens = 0;
      // True only when the loop ran out of iterations with the model still mid-work —
      // that stop must be announced, not silent (see the run_limit emit below).
      let exhausted = true;
      for (let i = 0; i < limit; i++) {
        if (runSignal.aborted) {
          exhausted = false;
          break;
        }
        // Auto-compaction runs as the `contextWindow` pipeline's default stage, so the
        // threshold policy is swappable without touching the loop.
        await this.pipelines.contextWindow.run({ messages: this.messages, reason: "auto" });
        // Publish the same figure the stage above just acted on, so a gauge
        // shows what the agent believes rather than only what a provider chose
        // to report.
        this.bus.emit({ type: "context_usage", ...this.contextUsage() });

        // request → assemble the prompt (default stage builds the system message);
        // streamRaw → call the provider; response → post-process (recovers JSON tool
        // calls when none came natively); assistantOutput → record + announce the reply.
        const request = await this.pipelines.request.run({
          system: { role: "system", content: "" },
          messages: this.messages,
          native,
        });
        // A `request` stage refused to let this go out (the budget's hard
        // ceiling). Ending here rather than mid-flight is the whole point: the
        // history stays well-formed, nothing is half-paid for, and the turn
        // closes with whatever it had already produced.
        if (request.refused !== undefined) {
          exhausted = false;
          break;
        }
        const raw = await this.streamRaw(request.system, request.messages, native, runSignal);
        const response = await this.pipelines.response.run({
          text: raw.text,
          calls: raw.calls,
          ...(raw.usage ? { usage: raw.usage } : {}),
        });

        const assistant: Message = { role: "assistant", content: response.text };
        if (response.calls.length > 0) assistant.toolCalls = response.calls;
        await this.pipelines.assistantOutput.run({ message: assistant });

        if (response.calls.length === 0) {
          exhausted = false;
          break;
        }

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

        // Token budget: each iteration re-bills the prompt, so the running total is
        // the turn's real spend. Checked after the tool results are recorded so the
        // history is never left with an unanswered tool_call.
        if (raw.usage) {
          usedTokens +=
            raw.usage.totalTokens ??
            (raw.usage.promptTokens ?? 0) + (raw.usage.completionTokens ?? 0);
          if (budget !== undefined && usedTokens >= budget) {
            this.bus.emit({ type: "run_limit", kind: "tokens", limit: budget, used: usedTokens });
            exhausted = false;
            break;
          }
        }
      }
      if (exhausted) {
        this.bus.emit({ type: "run_limit", kind: "iterations", limit, used: limit });
      }
    } catch (err) {
      // Carry the provider taxonomy when there is one, so the UI and the desktop
      // bridge can distinguish "your key is dead" from "the socket dropped"
      // without parsing the message.
      this.bus.emit(
        ProviderError.is(err)
          ? {
              type: "error",
              error: err.message,
              kind: err.kind,
              provider: err.provider,
              status: err.status,
              retryable: err.retryable,
            }
          : { type: "error", error: err instanceof Error ? err.message : String(err) },
      );
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
  ): Promise<{ text: string; calls: ToolCall[]; usage?: TokenUsage }> {
    const { provider, model, tools, temperature } = this.opts;
    const calls: ToolCall[] = [];
    let usage: TokenUsage | undefined;
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
        usage = chunk.usage;
        if (chunk.usage.promptTokens !== undefined)
          this.lastPromptTokens = chunk.usage.promptTokens;
        this.bus.emit({ type: "usage", usage: chunk.usage });
      }
    }

    return { text, calls, usage };
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

  /**
   * How full the context is right now, and whether that had to be estimated.
   * One definition, used by the compaction decision, the clear-tool-results
   * decision, and the gauge — so the meter can never disagree with the agent
   * about how much room is left.
   */
  contextUsage(): { used: number; window?: number; estimated: boolean } {
    const window = this.effectiveContextWindow();
    const reported = this.lastPromptTokens;
    return {
      used: reported ?? estimateHistoryTokens(this.messages),
      ...(window !== undefined ? { window } : {}),
      estimated: reported === undefined,
    };
  }

  /**
   * What the context is made of, by part.
   *
   * `contextUsage()` answers "how full", which is enough to decide whether to
   * compact and nothing else. It is not enough to act on: a window at 80% is a
   * different problem when it is 60k of tool output than when it is 60k of
   * conversation, and only one of those is fixed by compacting.
   *
   * The numbers are ESTIMATES, from the same ~4-chars-per-token heuristic the
   * compaction decision uses, and `total` will not generally equal
   * `contextUsage().used` — that one prefers the provider's reported prompt
   * tokens when there are any. Two different measurements of the same thing,
   * and a caller that presents them as one will show a discrepancy it cannot
   * explain. `total` is here to give the parts a denominator of their own.
   */
  async contextBreakdown(): Promise<ContextBreakdown> {
    const native =
      this.opts.tools.length > 0 && (await this.opts.provider.supportsNativeTools(this.opts.model));
    // The system message as it will actually be sent — including the project
    // instructions and, for a model without native tool-calling, the whole JSON
    // tool protocol. That last part is why `tools` is zero in the non-native
    // case rather than double-counted: the schemas ARE the system message there.
    const system = estimateTokens((await this.buildSystem(native)).content);
    const tools = native ? estimateTokens(JSON.stringify(this.toolSchemas())) : 0;
    let conversation = 0;
    let toolResults = 0;
    for (const message of this.messages) {
      const tokens = estimateMessageTokens(message);
      if (message.role === "tool") toolResults += tokens;
      else conversation += tokens;
    }
    return {
      system,
      tools,
      conversation,
      toolResults,
      total: system + tools + conversation + toolResults,
      messages: this.messages.length,
      nativeTools: native,
    };
  }

  /** True when the working history is close enough to the context window to compact. */
  private shouldAutoCompact(): boolean {
    const strategy = this.opts.context;
    const { used, window } = this.contextUsage();
    if (!window || !strategy || strategy.id === "none") return false;
    return used >= (this.opts.compactAtPercent ?? 0.75) * window;
  }

  private shouldClearToolResults(): boolean {
    if (this.opts.clearToolResults === false) return false;
    const window = this.effectiveContextWindow();
    if (!window) return false;
    const used = this.lastPromptTokens ?? estimateHistoryTokens(this.messages);
    return used >= (this.opts.clearAtPercent ?? 0.6) * window;
  }

  /** Placeholder marker — also the re-entry guard against clearing twice. */
  private static readonly CLEARED_PREFIX = "[cleared to save context";

  /**
   * Replace every tool result except the newest `keepRecentToolResults` with a
   * short placeholder. Only the CONTENT changes: role/toolCallId/name survive,
   * so native providers still see a result for every recorded tool call.
   */
  private clearStaleToolResults(): number {
    const keep = Math.max(0, this.opts.keepRecentToolResults ?? 3);
    const toolIndexes: number[] = [];
    for (let i = 0; i < this.messages.length; i++) {
      if (this.messages[i]?.role === "tool") toolIndexes.push(i);
    }
    let cleared = 0;
    for (const idx of toolIndexes.slice(0, Math.max(0, toolIndexes.length - keep))) {
      const msg = this.messages[idx];
      if (!msg || msg.content.length <= 200 || msg.content.startsWith(Agent.CLEARED_PREFIX)) {
        continue;
      }
      msg.content = `${Agent.CLEARED_PREFIX} — stale ${msg.name ?? "tool"} output dropped; call the tool again if you need it]`;
      cleared++;
    }
    return cleared;
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
