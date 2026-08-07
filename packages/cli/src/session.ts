import { randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";
import {
  Agent,
  type AgentEvent,
  type ArtermConfig,
  AutonomyEngine,
  type AutonomySnapshot,
  type AutonomyTask,
  Blackboard,
  type ChatProvider,
  CheckpointStore,
  Container,
  EventBus,
  FleetRegistry,
  GenAiTelemetry,
  MemberMemory,
  MemoryRecorder,
  type Message,
  type PermissionAsker,
  PermissionBroker,
  PermissionManager,
  type PermissionMode,
  PlanStore,
  ProcessRegistry,
  RunBudget,
  RunController,
  type SandboxRunner,
  SddRunner,
  TaskStore,
  type TeamMemberState,
  type TelemetrySubject,
  TodoStore,
  type TokenUsage,
  Tokens,
  type Tool,
  applyPatch,
  createBrainArbiterStage,
  createContextStrategy,
  createMemoryStore,
  createPermissionManager,
  createPipelines,
  createSddStore,
  createSubagentSession,
  declaredPaths,
  digest as digestObservations,
  estimateTokens,
  formatMemorySection,
  loadConfig,
  memberIsolation,
  planPath,
  resolveSandbox,
  runFleet,
  runSubagent,
  saveConfig,
  subagentPolicy,
  subagentRoster,
  sweepSpool,
  taskPath,
} from "@arterm/core";
import { type CmemEngine, createCmemEngine } from "@arterm/memory";
import {
  allProviders,
  buildAuthorizeUrl,
  createPkce,
  createProvider,
  createState,
  exchangeCode,
  oauthConfigFor,
  parseCallbackCode,
  setApiKey as persistApiKey,
  providerCatalog,
  removeApiKey,
  setOAuthTokens,
  storedKeyNames,
  withFallbacks,
} from "@arterm/providers";
import {
  type RollUpFn,
  WorkingDirStore,
  createBatchTool,
  createBrowserTools,
  createExecTool,
  createFleetTools,
  createForgetTool,
  createLlmTool,
  createMemorySearchTool,
  createPlanTool,
  createRelatedMemoriesTool,
  createRememberTool,
  createSandboxRunner,
  createSetWorkingDirTool,
  createSpawnParallelTool,
  createSpawnTool,
  createTaskTool,
  createTodoTool,
  createToolUseTool,
  defaultTools,
  disposeBrowsers,
  disposeLspClients,
  makeMemoTool,
  makeMessageTool,
  resetCallGraphs,
  taskDoneTool,
  toolHelpTool,
} from "@arterm/tools";
import type { Session } from "@arterm/tui";
import { armAutonomous } from "./flags.js";
import { startOtel } from "./otel.js";
import { createVerifier } from "./verifier.js";

export interface SessionOptions {
  config: ArtermConfig;
  providerId?: string;
  model?: string;
  yolo?: boolean;
  /** Re-prompt for destructive tools even in auto/yolo (overrides config). */
  confirmDestructive?: boolean;
  /**
   * Make `autonomy.maxSteps` bound eternal mode too (`--max-steps` was given
   * explicitly). CLI/CI hook only — config alone never bounds eternal.
   */
  hardCap?: boolean;
  cwd: string;
  /**
   * Nobody is at the keyboard (`--autonomous`, headless `--print`). Decides the
   * sandbox's fail policy: unattended refuses to run without its boundary,
   * attended warns and continues.
   */
  unattended?: boolean;
  /** Seed the agent's history (e.g. resuming a recorded session). */
  initialMessages?: Message[];
}

/**
 * Build the run's execution boundary, or decide what to do without one.
 *
 * The asymmetry is the point, and it mirrors `verify.ts`'s: the boundary FAILS
 * CLOSED for an unattended run and fails OPEN for an attended one. A warning is
 * a control only when someone reads it, and `--autonomous` is defined by nobody
 * being there — so for that run the absence of a sandbox has to be an error, not
 * a note scrolling past at minute two of six hours.
 *
 * Throwing here is deliberate: `buildSession` is upstream of every tool, every
 * sub-agent and every file write, so a refusal at this point means the run
 * genuinely did nothing rather than "did some of it, unconfined".
 */
async function establishSandbox(
  config: ArtermConfig,
  cwd: string,
  unattended: boolean,
): Promise<SandboxRunner | undefined> {
  const spec = resolveSandbox(config.sandbox, { cwd, unattended });
  if (!spec) return undefined;
  const attempt = await createSandboxRunner(spec);
  if (attempt.ok) {
    for (const w of attempt.warnings ?? []) process.stderr.write(`⚠ sandbox: ${w}\n`);
    return attempt.runner;
  }
  if (spec.failIfUnavailable) {
    const hint =
      "This run asked for a boundary and cannot get one, so it is refusing to start. " +
      "Install the sandbox prerequisites, or pass --no-sandbox to run unconfined.";
    throw new Error(`sandbox could not be established: ${attempt.reason}\n${hint}`);
  }
  process.stderr.write(
    `⚠ sandbox unavailable (${attempt.reason}) — shell commands run unconfined.\n`,
  );
  return undefined;
}

/**
 * Start the GenAI exporter, or say nothing and carry on.
 *
 * The opposite policy to the sandbox's, deliberately: a boundary that cannot be
 * established may stop a run, but telemetry never may. Observability that takes
 * down the thing it observes is a worse trade than none at all, so an
 * unreachable collector or a missing package degrades to one stderr line.
 */
async function startTelemetry(
  config: ArtermConfig,
  subject: TelemetrySubject,
): Promise<{ genai: GenAiTelemetry; shutdown: () => Promise<void> } | undefined> {
  if (!config.telemetry?.enabled) return undefined;
  const attempt = await startOtel({
    ...(config.telemetry.endpoint ? { endpoint: config.telemetry.endpoint } : {}),
    ...(config.telemetry.serviceName ? { serviceName: config.telemetry.serviceName } : {}),
    ...(config.telemetry.headers ? { headers: config.telemetry.headers } : {}),
  });
  if (!attempt.ok) {
    process.stderr.write(`⚠ telemetry disabled: ${attempt.reason}\n`);
    return undefined;
  }
  return {
    genai: new GenAiTelemetry(attempt.handle.sink, subject),
    shutdown: () => attempt.handle.shutdown(),
  };
}

/** Builds the wired-up session (agent + provider + tools + permissions) for the TUI. */
export async function buildSession(opts: SessionOptions): Promise<{
  session: Session;
  persist: () => Promise<void>;
  /** Digest this session's activity into persistent memory (call at session end). */
  digest: () => Promise<void>;
  /**
   * Wire the autonomy engine's crash-recovery checkpoint sink (main.ts points it
   * at a file next to the session transcript once the transcript id exists).
   */
  setAutonomyCheckpointSink: (
    sink?: (snap: AutonomySnapshot | null) => void | Promise<void>,
  ) => void;
}> {
  const { config, cwd } = opts;
  const providerId = opts.providerId ?? config.provider;
  const model = opts.model ?? config.model;

  const bus = new EventBus();
  // The model's own work list. Held outside the conversation so it survives
  // compaction — which is the whole reason it exists (see `todo.ts`).
  const todos = new TodoStore((items) => bus.emit({ type: "todo_changed", items }));
  // Background children. Built here rather than beside the tools, because the
  // teardown hook in `persist()` is the half that makes backgrounding safe and
  // it has to close over the same instance.
  const processes = new ProcessRegistry();
  // Where tool calls resolve. Confined to the session's own cwd by the store
  // itself — `set_working_dir` moves WITHIN the root it was built with, never
  // out of it, so the boundary every path-taking tool relies on is unchanged.
  const workingDir = new WorkingDirStore(cwd);
  // Checkpoints are per session; the transcript id isn't known yet at build time.
  const sessionCheckpointId = randomUUID();
  // A dependency graph the model can write, on the shape `/sdd` executes.
  const tasks = new TaskStore(taskPath(sessionCheckpointId));

  /**
   * Wrap a provider in the configured fallback chain. Rebuilt on every provider
   * switch so `/login` and `/model` can't leave the chain pointing at the old
   * primary. With no `fallbackModels` configured this returns `base` untouched.
   */
  const withChain = (base: ChatProvider): ChatProvider =>
    withFallbacks(
      base,
      (config.fallbackModels ?? []).map((f) => ({
        provider: f.provider ? createProvider(config, f.provider) : base,
        model: f.model,
      })),
      { onFallback: (notice) => bus.emit({ type: "provider_fallback", ...notice }) },
    );

  // Reassignable: /login swaps the active provider in place. The closures below
  // (sub-agent spawn, summarize, listModels) read this binding at call time, so
  // a switch propagates to all of them.
  let provider = withChain(createProvider(config, providerId));
  // Same factory the `permissions explain` command uses, so what it reports is
  // the policy this session actually runs under.
  const permissions = createPermissionManager(config, {
    ...(opts.yolo !== undefined ? { yolo: opts.yolo } : {}),
    ...(opts.confirmDestructive !== undefined
      ? { confirmDestructive: opts.confirmDestructive }
      : {}),
  });

  // Composition root (kernel D1): the DI Container holds the session's service graph
  // by token. For now it is bound to the SAME instances the wiring below already
  // creates, and the agent resolves three of them (bus, permissions, compactor) out of
  // it — so behavior is unchanged. Later phases let the agent loop and its pipelines
  // resolve services from here instead of receiving them directly.
  // One-shot, tool-free model call shared by the digest worker and the "summary"
  // context strategy. Reads the live `provider`/`config.model` bindings so a /login
  // or model switch propagates here too.
  const summarizeWith =
    (modelOverride?: string) =>
    async (prompt: string): Promise<string> => {
      let text = "";
      for await (const chunk of provider.chat({
        model: modelOverride ?? config.model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0,
      })) {
        if (chunk.type === "text") text += chunk.delta;
      }
      return text;
    };

  const summarizeOneShot = summarizeWith();

  // Memory-digest summarizer: prefer `config.memory.summarizeModel`, but fall back to
  // the main model if that override fails or yields nothing — otherwise a stale override
  // (e.g. an Ollama model name left set after switching to Anthropic) silently kills all
  // observation capture, since the observer treats a failed summarize as best-effort.
  const memorySummarize = async (prompt: string): Promise<string> => {
    const override = config.memory?.summarizeModel;
    if (override && override !== config.model) {
      try {
        const text = await summarizeWith(override)(prompt);
        if (text.trim()) return text;
      } catch {
        // Override model isn't valid for the active provider — fall through.
      }
    }
    return summarizeOneShot(prompt);
  };

  const contextStrategy = createContextStrategy(config, summarizeOneShot);
  const container = new Container()
    .bind(Tokens.Bus, () => bus)
    .bind(Tokens.PermissionPolicy, () => permissions)
    .bind(Tokens.Compactor, () => contextStrategy)
    .bind(Tokens.Pipelines, () => createPipelines())
    .bind(Tokens.TokenCounter, () => ({ count: (text: string) => estimateTokens(text) }));
  container.bind(Tokens.RunController, () => new RunController(container));

  // Persistent, project-scoped memory: capture this session's activity off the
  // bus, recall prior learnings into the system prompt, digest at session end.
  // Two mutually-exclusive engines: the legacy flat-learning pipeline, or the
  // richer `@arterm/memory` ("cmem") engine when config.memory.engine === "cmem".
  // Exactly one is wired per session, so recall is never double-injected and the
  // memory tools are never double-registered.
  const cmemActive = config.memory?.mode !== "off" && config.memory?.engine === "cmem";
  let cmem: CmemEngine | undefined;
  if (cmemActive) {
    cmem = await createCmemEngine({
      cwd,
      config,
      summarize: memorySummarize,
      embedHost: config.ollamaHost,
    });
    cmem.attach(bus);
  }

  // One counter for the whole run, shared with every sub-agent below: a fleet
  // must not be able to multiply the bill by spawning workers, so spend rolls
  // up into the parent ceiling rather than being re-granted per worker.
  const budget = new RunBudget({
    ...(config.budget?.runTokens !== undefined ? { tokens: config.budget.runTokens } : {}),
    ...(config.budget?.runUsd !== undefined ? { usd: config.budget.runUsd } : {}),
    ...(config.budget?.softRatio !== undefined ? { softRatio: config.budget.softRatio } : {}),
  });

  const memoryStore = createMemoryStore(config, cwd);
  const memoryEnabled = !cmemActive && memoryStore.id !== "off";
  const recorder = new MemoryRecorder();
  if (memoryEnabled) recorder.attach(bus);
  const maxInject = config.memory?.maxInject ?? 12;

  // Single source of truth for "what prior memory to surface": the cmem legend
  // when the rich engine is active, else the legacy learnings section. Feeds both
  // the agent's system-prompt `recall` hook and the visible session-start banner.
  const recallFn: (() => Promise<string> | string) | undefined = cmem
    ? () => cmem!.recall()
    : memoryEnabled
      ? async () => formatMemorySection(await memoryStore.recent(maxInject))
      : undefined;

  // Every permission prompt goes through the broker: it publishes the pending
  // request for the desktop status server and lets either side answer it. The
  // TUI installs the real prompt via `setAsker`; until then it denies (headless
  // `--print` never installs one, so its behaviour is unchanged).
  const permissionBroker = new PermissionBroker(bus);
  const asker: PermissionAsker = permissionBroker.ask;

  // The execution boundary, established BEFORE the agent exists. A run whose
  // sandbox must hold and cannot be built has to stop here, with nothing
  // spawned and nothing written — "start, then discover the boundary is
  // missing" is the same as having none, because the first command has already
  // run by then.
  const sandbox = await establishSandbox(config, cwd, opts.unattended === true);

  const agent = new Agent({
    provider,
    model,
    tools: defaultTools(config.tools?.tier),
    permissions: container.resolve(Tokens.PermissionPolicy),
    ask: (tool, args) => asker(tool, args),
    bus: container.resolve(Tokens.Bus),
    cwd,
    initialMessages: opts.initialMessages,
    temperature: config.temperature,
    context: container.resolve(Tokens.Compactor),
    contextWindow: config.context?.window,
    compactAtPercent: config.context?.compactAtPercent,
    turnTokenBudget: config.budget?.turnTokens,
    maxIterations: config.budget?.maxIterations,
    clearToolResults: config.context?.clearToolResults,
    clearAtPercent: config.context?.clearAtPercent,
    keepRecentToolResults: config.context?.keepRecentToolResults,
    loopDetect: config.loopDetect,
    budget,
    ...(sandbox ? { sandbox } : {}),
    ...(config.credentials ? { credentials: config.credentials } : {}),
    processes,
    workingDir,
    recall: recallFn,
    container,
  });

  // GenAI telemetry (`gen_ai.*` spans + metrics), when an exporter is
  // configured. Installed as pipeline stages rather than read off the bus for
  // the model and tool spans, because duration is the point and bus events
  // would fold tool time into the provider's — see `core/src/telemetry.ts`.
  const telemetry = await startTelemetry(config, () => ({
    model: agent.model,
    provider: providerId,
  }));
  if (telemetry) {
    const pipelines = container.resolve(Tokens.Pipelines);
    // One `stages()` call: both middlewares share the instance's pending-span
    // slot, so calling it twice would only obscure that they are a pair.
    const stages = telemetry.genai.stages();
    pipelines.request.use("telemetry", stages.request);
    pipelines.response.use("telemetry", stages.response);
    pipelines.toolCall.before("execute", telemetry.genai.toolStage());
    telemetry.genai.attach(bus);
  }

  // Checkpoints: snapshot a file's contents BEFORE the tool that writes it, so
  // a turn can be undone. Registered `before` the permission stage rather than
  // before `execute` so a denied call costs nothing — capture is cheap, but
  // snapshotting for work that never happens would fill the store with noise.
  // Only path-declaring tools are covered; `bash` declares none, which is the
  // documented hole rather than a silent one.
  const checkpoints = new CheckpointStore(cwd, sessionCheckpointId);
  // The turn's label comes from the prompt that started it — the picker has to
  // read like the conversation, not like a list of ids.
  container.resolve(Tokens.Pipelines).userInput.use("checkpointTurn", async (ctx, next) => {
    checkpoints.beginTurn(ctx.input);
    await next();
  });
  container.resolve(Tokens.Pipelines).toolCall.before("permission", async (ctx, next) => {
    const paths = declaredPaths(ctx.call.name, ctx.call.arguments).map((p) =>
      isAbsolute(p) ? p : join(cwd, p),
    );
    if (paths.length > 0) await checkpoints.capture(paths);
    await next();
  });
  // Turn boundaries: the agent's own events, so a checkpoint covers exactly one
  // user turn no matter which surface (TUI, headless, autonomy step) drove it.
  bus.on((e) => {
    if (e.type === "turn_end") void checkpoints.commitTurn();
  });
  // Housekeeping, best-effort and never blocking startup.
  void checkpoints.prune().catch(() => {});

  // Optional gatekeeper (config `arbiter.model`): screen execute-category tool
  // calls with a cheap model BEFORE the permission chain (inserted `before` the
  // agent's own `permission` stage). It can only BLOCK — the regex RiskArbiter
  // and the permission mode still decide everything it lets through.
  if (config.arbiter?.enabled !== false && config.arbiter?.model) {
    container.resolve(Tokens.Pipelines).toolCall.before(
      "permission",
      createBrainArbiterStage({
        provider,
        model: config.arbiter.model,
        bus,
        toolFor: (name) => agent.tools.find((t) => t.name === name),
      }),
    );
  }

  // Live sub-agent tool set, read from `agent.tools` at spawn time — after main.ts
  // has folded in MCP/plugin tools, so sub-agents inherit them. The delegation
  // tools stay out (depth is one level), and an optional allowlist narrows the set
  // (team members with a `tools:` frontmatter list).
  const subagentTools = (allow?: string[]): Tool[] => subagentRoster(agent.tools, allow);

  // Sub-agent delegation: the main agent gets a `spawn` tool that runs a fresh
  // sub-agent (own history, the core tool set, no `spawn` of its own → one level
  // deep) toward a task and returns its result.
  const spawnFn = async (task: string, role?: string): Promise<string> => {
    bus.emit({ type: "subagent_start", task, role });
    // Resolved at dispatch time (the live mode is mutable): autonomous sessions
    // give sub-agents a fail-closed auto policy so a fleet never blocks on a
    // prompt; supervised sessions keep routing prompts to the user.
    const sub = subagentPolicy(config, permissions);
    const output = await runSubagent(task, {
      provider,
      model: agent.model,
      tools: subagentTools(),
      permissions: sub?.permissions ?? permissions,
      // Tagged so the prompt says WHICH worker is blocked, not just the tool name.
      ask: sub?.ask ?? permissionBroker.askFor({ name: role ?? "sub-agent" }),
      cwd,
      taskDone: taskDoneTool,
      context: createContextStrategy(config),
      maxSteps: config.autonomy?.maxSteps,
      maxIterations: config.budget?.maxIterations,
      turnTokenBudget: config.budget?.turnTokens,
      contextWindow: config.context?.window,
      compactAtPercent: config.context?.compactAtPercent,
      loopDetect: config.loopDetect,
      budget,
      ...(sandbox ? { sandbox } : {}),
      ...(config.credentials ? { credentials: config.credentials } : {}),
      processes,
      role,
    });
    bus.emit({ type: "subagent_done", output, role });
    return output;
  };

  /** Bumped per bare `spawn_parallel` dispatch, so its minted row ids stay unique. */
  let fleetRound = 0;

  // Team blackboard: a shared space members read/write across rounds (breaks the
  // star topology). Disabled → pure leader-only aggregation. Same instance is
  // handed to the engine (result-posting + brief injection) and to each member's
  // `message` tool below.
  const blackboard = config.team?.blackboard === false ? undefined : new Blackboard();

  // Per-member private memory: what a member carries across its own rounds (its
  // `memo` notes + a recap of its output). Disabled → members start each round with
  // no memory of their own earlier work. Same instance goes to the engine (recap +
  // recall injection) and to each member's `memo` tool below.
  const memberMemory = config.team?.memory === false ? undefined : new MemberMemory();

  // Parallel fan-out: run several independent sub-tasks concurrently. Team tasks
  // (those carrying a member id) additionally get per-member tools + isolation, an
  // id-tagged event bridge to the shared bus, and patch auto-apply per
  // config.team.mergeStrategy once the round returns.
  const runFleetTasks = async (tasks: AutonomyTask[], signal?: AbortSignal) => {
    const teamRun = tasks.some((t) => t.member);
    // A bare `spawn_parallel` call arrives id-less: nothing planned a round for
    // it, so nothing seeded a board either. Mint round-scoped ids here (an id is
    // what buys a task its live row and its id-tagged event bridge) and ship them
    // on `fleet_start`, which is then this dispatch's plan event. Planned runs
    // (team roster, autonomy rounds) already carry ids and have seeded the board
    // themselves — they pass through untouched.
    const unplanned = !teamRun && tasks.every((t) => !t.id);
    const round = unplanned ? ++fleetRound : 0;
    const fleet: AutonomyTask[] = unplanned
      ? tasks.map((t, i) => ({ ...t, id: `f${round}-${i + 1}` }))
      : tasks;
    bus.emit({
      type: "fleet_start",
      count: fleet.length,
      ...(unplanned
        ? {
            tasks: fleet.map((t) => ({ id: t.id as string, task: t.task, role: t.role })),
          }
        : {}),
    });
    // One dispatch-time policy for the whole round (same reasoning as spawnFn).
    const sub = subagentPolicy(config, permissions);
    const isolationMode = config.team?.isolation ?? "auto";
    const fleetTasks = fleet.map((t) => {
      const id = t.id;
      const name = t.role ?? (t.member ? "member" : "subtask");
      // Every dispatched task — plain parallel subtask as much as team member —
      // gets an id-tagged event bridge, so the live board can show what each
      // sub-agent is doing right now instead of just "started" / "finished".
      const onEvent = id
        ? (e: AgentEvent) => bus.emit({ type: "team_member_event", id, name, event: e })
        : undefined;
      // Same reasoning as the event bridge: a prompt raised mid-fan-out has to name
      // its worker, or the user sees "write_file" with five identical rows above it
      // and no way to tell which one is waiting.
      const ask = sub?.ask ?? permissionBroker.askFor({ id, name });
      // Only team members get the member-only extras below; an id alone just
      // buys a task its board row. (`!id` can't happen for a member, but it
      // would leave the tools below without an author, so treat it as plain.)
      if (!t.member || !id) return { task: t.task, role: t.role, id, onEvent, ask };
      const memberTools = subagentTools(t.toolNames);
      // Team members always get a `message` tool (independent of their allowlist)
      // so they can post to / address teammates on the shared board.
      if (blackboard) {
        memberTools.push(makeMessageTool({ board: blackboard, selfId: id, selfName: name, bus }));
      }
      // Likewise a `memo` tool, so a member can leave notes for its own next round.
      if (memberMemory) {
        memberTools.push(makeMemoTool({ memory: memberMemory, selfId: id, selfName: name, bus }));
      }
      return {
        task: t.task,
        role: t.role,
        id,
        instruction: t.instruction,
        systemPrompt: t.systemPrompt,
        tools: memberTools,
        // "auto": writers isolate in a worktree, read-only members share the cwd.
        isolation: isolationMode === "auto" ? memberIsolation(memberTools) : isolationMode,
        onEvent,
        ask,
      };
    });
    const results = await runFleet(
      fleetTasks,
      {
        provider,
        model: agent.model,
        tools: subagentTools(),
        permissions: sub?.permissions ?? permissions,
        ask: sub?.ask ?? ((tool, args) => asker(tool, args)),
        cwd,
        taskDone: taskDoneTool,
        context: createContextStrategy(config),
        maxSteps: config.autonomy?.maxSteps,
        maxIterations: config.budget?.maxIterations,
        turnTokenBudget: config.budget?.turnTokens,
        contextWindow: config.context?.window,
        compactAtPercent: config.context?.compactAtPercent,
        loopDetect: config.loopDetect,
        budget,
        // Worktree-isolated workers land under the OS temp dir, which is
        // already a write root — so isolation and confinement compose rather
        // than the boundary refusing every command a `/sdd` wave runs.
        ...(sandbox ? { sandbox } : {}),
        ...(config.credentials ? { credentials: config.credentials } : {}),
        concurrency: config.fleet?.concurrency,
        isolation: config.fleet?.isolation ?? "none",
        onStart: (i, task, role) => {
          bus.emit({ type: "subagent_start", task, role, id: fleet[i]?.id });
          const t = fleet[i];
          if (t?.id) {
            bus.emit({
              type: "team_member_state",
              id: t.id,
              name: t.role ?? (t.member ? "member" : "subtask"),
              state: "running",
              task: t.task,
            });
          }
        },
        onDone: (i, output, result) => {
          const t = fleet[i];
          bus.emit({ type: "subagent_done", output, role: t?.role, id: t?.id });
          if (t?.id) {
            bus.emit({
              type: "team_member_state",
              id: t.id,
              name: t.role ?? (t.member ? "member" : "subtask"),
              state: result?.error ? "failed" : "done",
              task: t.task,
              filesChanged: result?.worktree?.files.length,
            });
          }
        },
        onWorktree: (_i, info) => bus.emit({ type: "fleet_worktree", ...info }),
      },
      signal,
    );
    bus.emit({ type: "fleet_done", count: results.length });

    // First consumer of mergeStrategy: bring worktree patches back onto the main
    // tree, sequentially so conflicts are attributed to one member. Teams default
    // to "apply"; the plain fleet keeps its "surface" default. A conflict marks
    // the member failed — its branch survives (removeWorktree keeps changed
    // branches) for manual recovery.
    const strategy = teamRun
      ? (config.team?.mergeStrategy ?? "apply")
      : (config.fleet?.mergeStrategy ?? "surface");
    if (strategy === "apply") {
      for (const r of results) {
        if (!r.worktree?.patch) continue;
        const applied = await applyPatch(cwd, r.worktree.patch, signal);
        const name = r.role ?? "member";
        if (r.id) {
          bus.emit({
            type: "team_patch",
            id: r.id,
            name,
            ok: applied.ok,
            files: r.worktree.files.length,
            detail: applied.detail,
          });
        }
        if (applied.ok) {
          r.output = `${r.output}\n[patch applied to the main working tree]`;
        } else {
          r.error = true;
          r.output = `${r.output}\n[patch conflict — branch ${r.worktree.branch} kept: ${applied.detail ?? "git apply failed"}]`;
          if (r.id) {
            bus.emit({
              type: "team_member_state",
              id: r.id,
              name,
              state: "failed",
              filesChanged: r.worktree.files.length,
            });
          }
        }
      }
    }
    return results.map((r) => ({
      task: r.task,
      role: r.role,
      id: r.id,
      output: r.output,
      error: r.error,
    }));
  };

  // The `spawn_parallel` tool form (no abort signal; the model drives it).
  const fleetFn = (tasks: { task: string; role?: string }[]) =>
    runFleetTasks(tasks).then((rs) => rs.map((r) => ({ task: r.task, output: r.output })));

  // Model-driven fleet. `spawn`/`spawn_parallel` above are the ENGINE's shape:
  // the caller decides the whole fan-out and waits for it. These workers persist
  // across tasks and are assigned to without blocking, which is what lets the
  // model decide wave 2 after wave 1 has answered.
  //
  // Declared before the registry, not after: `onChange` closes over it and the
  // registry can fire during construction of anything that spawns.
  const lastWorkerState = new Map<string, TeamMemberState>();
  const fleetRegistry = new FleetRegistry({
    maxWorkers: config.fleet?.maxWorkers,
    createWorker: (spec) => {
      // Dispatch-time policy, same as spawnFn: an autonomous session gives
      // workers a fail-closed asker so a fleet never blocks on a prompt.
      const sub = subagentPolicy(config, permissions);
      const session = createSubagentSession({
        provider,
        model: agent.model,
        tools: subagentTools(spec.tools),
        permissions: sub?.permissions ?? permissions,
        ask: sub?.ask ?? permissionBroker.askFor({ id: spec.id, name: spec.name }),
        cwd,
        taskDone: taskDoneTool,
        context: createContextStrategy(config),
        maxSteps: config.autonomy?.maxSteps,
        maxIterations: config.budget?.maxIterations,
        turnTokenBudget: config.budget?.turnTokens,
        contextWindow: config.context?.window,
        compactAtPercent: config.context?.compactAtPercent,
        loopDetect: config.loopDetect,
        // The parent's counter: a model that can spawn workers must not be able
        // to spend past the ceiling the run was granted by spawning more.
        budget,
        ...(sandbox ? { sandbox } : {}),
        ...(config.credentials ? { credentials: config.credentials } : {}),
        ...(spec.role !== undefined ? { role: spec.role } : {}),
        ...(spec.brief !== undefined ? { instruction: spec.brief } : {}),
        onEvent: (event) =>
          bus.emit({ type: "team_member_event", id: spec.id, name: spec.name, event }),
      });
      return {
        run: (task, signal) => session.run(task, undefined, signal),
        stop: () => session.stop(),
      };
    },
    // The swarm board already knows how to draw workers; these are workers.
    // Diffed rather than re-emitted, because the registry reports every task
    // transition and a board that repaints on each one flickers for no reason.
    onChange: () => {
      for (const w of fleetRegistry.listWorkers()) {
        const running = fleetRegistry
          .listTasks()
          .find((t) => t.workerId === w.id && t.state === "running");
        const state =
          w.state === "terminated"
            ? "failed"
            : running
              ? "running"
              : w.finished > 0
                ? "done"
                : "pending";
        if (lastWorkerState.get(w.id) === state) continue;
        lastWorkerState.set(w.id, state);
        bus.emit({
          type: "team_member_state",
          id: w.id,
          name: w.name,
          state,
          ...(running ? { task: running.task } : {}),
        });
      }
    },
  });

  /**
   * One model call, metered.
   *
   * `summarizeWith` above bypasses the agent loop, and `budgetMeter` is a
   * `response` PIPELINE stage inside it — so every one-shot made this way is
   * invisible to `--budget` and to the spend a headless run reports. That was
   * already true of `roll_up`, which this now also routes through: a leader
   * that can summarise a fleet's output without it counting is a leader that
   * can spend past the ceiling the run was granted, which is the exact hole
   * `RunBudget` sharing exists to close on the sub-agent path.
   *
   * No history, ever. `Agent.plan()` looks like the same call and prepends the
   * whole conversation, which is the cost these one-shots exist to avoid.
   */
  const oneShot = async (req: {
    prompt: string;
    system?: string;
    model?: string;
    schema?: Record<string, unknown>;
    signal?: AbortSignal;
  }): Promise<string> => {
    const messages: Message[] = [];
    if (req.system) messages.push({ role: "system", content: req.system });
    const asked = req.schema
      ? `${req.prompt}\n\nReply with JSON matching this schema, and nothing else:\n${JSON.stringify(req.schema)}`
      : req.prompt;
    messages.push({ role: "user", content: asked });

    let text = "";
    let usage: TokenUsage | undefined;
    for await (const chunk of provider.chat({
      // A model NAME on the provider already in use — never a provider
      // selector, which is what keeps this from becoming an egress channel.
      model: req.model ?? config.model,
      messages,
      temperature: 0,
      ...(req.signal ? { signal: req.signal } : {}),
    })) {
      if (chunk.type === "text") text += chunk.delta;
      else if (chunk.type === "done" && chunk.usage) usage = chunk.usage;
    }
    if (usage) budget.spend(usage, req.model ?? config.model, provider.id);
    return text;
  };

  /**
   * Re-enter the permission ladder for a tool dispatched by another tool.
   *
   * `batch` used to test `tool.permission !== "allow"` — the tool's DEFAULT,
   * not its effective level. `PermissionManager.level()` is
   * `overrides[name] ?? tool.permission`, so a user whose config said
   * `{"permissions": {"web_fetch": "deny"}}` was obeyed for a direct call and
   * IGNORED inside a batch, against the rule that a hard tool-level deny wins
   * in every mode. It also never consulted the mode, so `test` — `allow` but
   * `category: "execute"` — ran inside a batch in plan mode, where a direct
   * call is denied.
   */
  const dispatchGate = async (
    tool: Tool,
    args: Record<string, unknown>,
  ): Promise<{ allowed: boolean; reason?: string }> => {
    const decision = await permissions.check(tool, args, asker);
    if (decision.allowed) return { allowed: true };
    return {
      allowed: false,
      reason: decision.reason ?? `"${tool.name}" was not permitted.`,
    };
  };

  // `roll_up`'s summariser: the same tool-free one-shot the context strategy
  // uses. Deliberately NOT `agent.plan()`, which prepends the leader's whole
  // history — the point of rolling up is that the results do not travel through
  // the leader's context, and plan() would send it along with them.
  const rollUp: RollUpFn = async (parts, focus) => {
    const body = parts.map((p) => `### ${p.label}\n${p.text}`).join("\n\n");
    const ask = focus
      ? `Summarise these sub-agent results with a focus on: ${focus}`
      : "Summarise these sub-agent results.";
    return oneShot({
      prompt: `${ask}\nKeep every concrete finding (files, symbols, numbers). Say plainly where they disagree.\n\n${body}`,
    });
  };

  agent.setTools([
    ...agent.tools,
    createTodoTool(todos),
    createPlanTool(new PlanStore(planPath(sessionCheckpointId))),
    createTaskTool(tasks),
    createSpawnTool(spawnFn),
    createSpawnParallelTool(fleetFn),
    ...createFleetTools({ registry: fleetRegistry, rollUp }),
    createLlmTool(oneShot),
    toolHelpTool,
    // The gate IS the ladder. Both of these dispatch to another tool's
    // `execute`, which means the agent's `toolCall.permission` stage already ran
    // — for the dispatcher, not for what it dispatches. Handing them
    // `permissions.check` makes the inner call obey exactly the rules a direct
    // call would, prompt included, and makes the prompt name the inner tool.
    createToolUseTool({ gate: dispatchGate }),
    createSetWorkingDirTool(workingDir),
    // A browser is a long-lived child like a language server: started on
    // demand, cached, and closed by `persist()` below.
    ...createBrowserTools(),
    createBatchTool({ gate: dispatchGate }),
    createExecTool({
      registry: processes,
      // From the user's config only — see `ExecToolOptions.extraAllowed`.
      ...(config.exec?.allow ? { extraAllowed: config.exec.allow } : {}),
    }),
    ...(cmem
      ? cmem.tools()
      : memoryEnabled
        ? [
            createMemorySearchTool(memoryStore),
            createRememberTool(memoryStore),
            createForgetTool(memoryStore),
            createRelatedMemoriesTool(memoryStore),
          ]
        : []),
  ]);

  // End-of-session digest: compress buffered activity into durable learnings via
  // a quiet, tool-free single-shot model call (Arterm's claude-mem "worker"). Same
  // one-shot the "summary" context strategy uses; see `summarizeOneShot` above.
  const summarize = summarizeOneShot;

  // Single-flight: a periodic digest and the end-of-session digest must never run
  // concurrently (they share the buffer and the model). The same `digest` name is
  // returned for both engines so `main.ts`'s shutdown call is engine-agnostic.
  let digesting = false;
  const digest = async (): Promise<void> => {
    if (digesting) return;
    if (cmem) {
      // cmem engine: run the observer over buffered activity.
      digesting = true;
      try {
        await cmem.observe();
      } finally {
        digesting = false;
      }
      return;
    }
    if (!memoryEnabled || config.memory?.autoDigest === false) return;
    const observations = recorder.observations();
    if (observations.length === 0) return;
    digesting = true;
    try {
      const learnings = await digestObservations(observations, summarize);
      for (const record of learnings) await memoryStore.append(record);
    } finally {
      // Always reset the window: digestObservations never throws, and a model that
      // produced nothing parseable shouldn't wedge the periodic trigger.
      recorder.clear();
      digesting = false;
    }
  };

  // Periodic, claude-mem-style digest: fire after every N captured observations.
  const digestEvery = config.memory?.digestEvery ?? 20;
  if (cmem && digestEvery > 0) {
    cmem.recorder.setAutoFlush(digestEvery, () => {
      void digest();
    });
  } else if (memoryEnabled && config.memory?.autoDigest !== false && digestEvery > 0) {
    recorder.setAutoFlush(digestEvery, () => {
      void digest();
    });
  }

  // Result verification: a deterministic command gate, with a fresh-context judge
  // behind it. Built in verifier.ts so the judge runner is testable with a stub
  // provider; getters (not values) so /model and /login propagate mid-session.
  const verifier = createVerifier({
    provider: () => provider,
    model: () => agent.model,
    tools: () => agent.tools,
    context: () => createContextStrategy(config),
    cwd,
    config,
  });

  const autonomy = new AutonomyEngine(agent, bus, taskDoneTool, {
    mode: config.autonomy?.mode ?? "once",
    maxSteps: config.autonomy?.maxSteps,
    maxPhases: config.autonomy?.maxPhases,
    fanout: config.autonomy?.phasedFanout ?? config.fleet?.concurrency,
    teamFanout: config.team?.fanout,
    teamRounds: config.team?.maxRounds,
    runFleet: (tasks, signal) => runFleetTasks(tasks, signal),
    blackboard,
    memberMemory,
    verify: verifier,
    verifyAttempts: config.verify?.attempts,
    verifyPersist: config.verify?.persist,
    autoExtend: config.autonomy?.autoExtend,
    extendBy: config.autonomy?.extendBy,
    stepTimeoutMs: config.autonomy?.stepTimeoutMs,
    failureBudget: config.autonomy?.failureBudget,
    cycleGapMs: config.autonomy?.cycleGapMs,
    eternalCompletion: config.autonomy?.eternalCompletion,
    hardCap: opts.hardCap,
    budget,
  });

  // Set while Shift+Tab's AUTONOMOUS slot is armed; calling it disarms. Doubles
  // as the armed/idempotency flag for `setAutonomous` below.
  let disarmAutonomous: (() => string[]) | undefined;

  const sdd = new SddRunner(
    agent,
    bus,
    (tasks, signal) => runFleetTasks(tasks, signal),
    createSddStore(),
    {
      maxQuestions: config.sdd?.maxQuestions,
      maxTasks: config.sdd?.maxTasks,
      handoffChars: config.sdd?.handoffChars,
      specChars: config.sdd?.specChars,
      fanout: config.fleet?.concurrency,
      cwd,
      // The gate must run in the tree the workers wrote to. /sdd's fleet defaults
      // to `isolation: "none"`, so that is `cwd`; a worktree-isolated fleet with
      // `mergeStrategy: "surface"` leaves the changes on a branch instead, and
      // verifying `cwd` there would review a tree without the work in it.
      ...(config.fleet?.isolation === "worktree" && config.fleet?.mergeStrategy !== "apply"
        ? {}
        : { verify: verifier }),
    },
  );

  // One-time snapshot of prior memory to display at startup (claude-mem-style).
  // Never let a memory read block session startup.
  let memoryBanner = "";
  if (recallFn) {
    try {
      memoryBanner = (await recallFn()).trim();
    } catch {
      memoryBanner = "";
    }
  }

  const session: Session = {
    processes,
    agent,
    bus,
    config,
    get providerLabel() {
      return provider.id;
    },
    toolCount: agent.tools.length,
    yolo: opts.yolo ?? false,
    setAsker(next) {
      permissionBroker.setAsker(next);
    },
    permissionBroker,
    listModels: () => provider.listModels(),
    listAllModels: async () => {
      // Aggregate across local backends + every provider with a stored/env key,
      // each model tagged with its provider id. Unreachable backends are skipped.
      const lists = await Promise.all(
        allProviders(config).map((p) => p.listModels().catch(() => [])),
      );
      return lists.flat();
    },
    switchModel(next) {
      agent.setModel(next);
      config.model = next;
    },
    switchProvider(id) {
      provider = withChain(createProvider(config, id));
      agent.setProvider(provider);
      config.provider = id;
    },
    setApiKey(name, key) {
      persistApiKey(name, key);
    },
    async configureOpenAICompat({ host, key }) {
      const trimmed = host.trim();
      config.openaiCompatHost = trimmed;
      // Gateways like agentrouter.org reject unknown clients by User-Agent; send
      // the CLI UA that passes so a pasted host+key just works out of the box.
      if (/agentrouter\.org/i.test(trimmed)) {
        config.openaiCompatHeaders = { "user-agent": "claude-cli/2.0.0 (external, cli)" };
      }
      if (key) persistApiKey("openai-compat", key);
      config.provider = "openai-compat";
      provider = withChain(createProvider(config, "openai-compat"));
      agent.setProvider(provider);
      // Persist host + headers now — a deliberate login action, so it's safe to
      // write these fields (the generic persist() overlay doesn't include them).
      const disk = await loadConfig();
      await saveConfig({
        ...disk,
        provider: "openai-compat",
        openaiCompatHost: config.openaiCompatHost,
        openaiCompatHeaders: config.openaiCompatHeaders,
      });
    },
    removeApiKey(name) {
      removeApiKey(name);
    },
    // OAuth tokens are stored as "<id>-oauth" — normalize so the overlay marks
    // e.g. anthropic as signed in after a subscription login too.
    signedInProviders: () => [...new Set(storedKeyNames().map((n) => n.replace(/-oauth$/, "")))],
    loginProviders: [...providerCatalog],
    compact: () => agent.compact("manual"),
    // A getter, not a snapshot: this was read once at build time, so `--yolo` and
    // every Shift+Tab afterwards left it reporting the config's default. The
    // status snapshot publishes this field to the desktop, and `/permissions`
    // evaluates against it — both were describing a mode nobody was running.
    get permissionMode() {
      return permissions.getMode();
    },
    setMode(next) {
      permissions.setMode(next);
      config.mode = next;
    },
    // Shift+Tab's AUTONOMOUS slot. Runtime-only on purpose: unlike setMode
    // above, this never writes config (the config is persisted on exit, and
    // "quit while armed" must not mean "boot in yolo forever after").
    setAutonomous(on) {
      if (on) {
        if (disarmAutonomous) return [];
        const armed = armAutonomous({ config, permissions, engine: autonomy });
        disarmAutonomous = armed.disarm;
        return armed.messages;
      }
      if (!disarmAutonomous) return [];
      const out = disarmAutonomous();
      disarmAutonomous = undefined;
      return out;
    },
    // Read through the LIVE provider variable: switchProvider reassigns it, and
    // the report must come from whoever is actually answering.
    rateLimits: () => provider.rateLimits?.(),
    budgetState: () => budget.state(),
    // The boundary as a fact about the session, not a startup log line that has
    // long since scrolled away.
    ...(sandbox ? { sandboxDescription: sandbox.describe } : {}),
    checkpoints: {
      list: () => checkpoints.list(),
      restore: (id) => checkpoints.restore(id),
      redoTarget: () => checkpoints.redoTarget,
    },
    autonomy,
    sdd,
    mcpServers: [],
    plugins: [],
    skills: [],
    getSkillBody: () => undefined,
    memoryBanner,
  };

  const persist = async () => {
    // Model-spawned workers are the one thing here that can still be RUNNING at
    // teardown: nothing awaited them, which is the point of assigning without
    // blocking. Stopping them first means a closing session does not leave a
    // sub-agent making provider calls against a run nobody is watching.
    fleetRegistry.dispose();
    // Language servers are the other long-lived child. They are cached for the
    // process precisely so a second question is cheap, which means nothing else
    // ever closes them.
    await disposeLspClients().catch(() => {});
    await disposeBrowsers().catch(() => 0);
    resetCallGraphs();
    // The reason background execution is safe to offer at all: what the session
    // started, the session stops. Without this a dev server launched in minute
    // two of a six-hour run still holds its port tomorrow.
    processes.killAll();
    // Flush the exporter here rather than behind a fourth returned function:
    // `persist` is the last call on EVERY teardown path (headless, session
    // close, close-all), and a batch processor that is never shut down drops
    // the spans of the run that just ended — the ones anyone is looking for.
    // Never throws: a collector that went away must not fail a good run.
    await telemetry?.shutdown().catch(() => {});
    // Spooled tool outputs, swept here for the same reason: this is the last
    // call on every teardown path. Done at the END of a session rather than on
    // each write — the directory grows by a few files per run, and a sweep on
    // the write path would add a directory listing to a tool call that is
    // already over its budget.
    await sweepSpool().catch(() => 0);
    config.provider = provider.id;
    config.permissions = permissions.snapshot();
    // Persist auto/plan/ask as the default, but never make yolo sticky.
    const current = permissions.getMode();
    config.mode = current === "yolo" ? "ask" : current;
    // Overlay only the fields this session owns onto the on-disk config, so a
    // long-running session doesn't clobber edits made outside it (hosts,
    // headers, keys-adjacent settings) with its stale in-memory snapshot.
    const disk = await loadConfig();
    await saveConfig({
      ...disk,
      provider: config.provider,
      model: config.model,
      permissions: config.permissions,
      mode: config.mode,
    });
  };
  // Let the TUI persist a model/provider/login choice immediately instead of
  // only on clean exit, so it survives a crash and becomes the next default.
  session.persistNow = persist;

  // Subscription (OAuth/PKCE) login driven from the TUI's /login overlay — the
  // same flow as `arterm login`, but the code is pasted into the overlay instead
  // of stdin. The PKCE verifier/state live here between start and complete.
  const pendingOAuth = new Map<string, { verifier: string; state: string }>();
  session.startOAuth = async (id) => {
    const oauthConfig = oauthConfigFor(id);
    if (!oauthConfig) throw new Error(`${id} doesn't support subscription login`);
    const { verifier, challenge } = createPkce();
    const state = createState();
    pendingOAuth.set(id, { verifier, state });
    const url = buildAuthorizeUrl(oauthConfig, { challenge, state });
    // Best-effort: if the browser can't be spawned the overlay still shows the URL.
    const { openBrowser } = await import("./browser.js");
    await openBrowser(url).catch(() => {});
    return url;
  };
  session.completeOAuth = async (id, pastedCode) => {
    const oauthConfig = oauthConfigFor(id);
    const pending = pendingOAuth.get(id);
    if (!oauthConfig || !pending) throw new Error("no subscription login in progress");
    const { code, state: returned } = parseCallbackCode(pastedCode);
    if (returned && returned !== pending.state) {
      throw new Error("state mismatch — login aborted for safety, try again");
    }
    const tokens = await exchangeCode(oauthConfig, {
      code,
      verifier: pending.verifier,
      state: returned ?? pending.state,
    });
    setOAuthTokens(id, tokens);
    pendingOAuth.delete(id);
  };

  return {
    session,
    persist,
    digest,
    setAutonomyCheckpointSink: (sink) => autonomy.setCheckpointSink(sink),
  };
}
