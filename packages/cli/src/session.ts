import {
  Agent,
  type ArtermConfig,
  AutonomyEngine,
  Container,
  EventBus,
  MemoryRecorder,
  type Message,
  type PermissionAsker,
  PermissionManager,
  type PermissionMode,
  RiskArbiter,
  RunController,
  SddRunner,
  Tokens,
  createContextStrategy,
  createMemoryStore,
  createPipelines,
  createSddStore,
  digest as digestObservations,
  estimateTokens,
  formatMemorySection,
  runFleet,
  runSubagent,
  saveConfig,
} from "@arterm/core";
import { type CmemEngine, createCmemEngine } from "@arterm/memory";
import {
  allProviders,
  createProvider,
  setApiKey as persistApiKey,
  providerCatalog,
  removeApiKey,
  storedKeyNames,
} from "@arterm/providers";
import {
  createMemorySearchTool,
  createRememberTool,
  createSpawnParallelTool,
  createSpawnTool,
  defaultTools,
  taskDoneTool,
} from "@arterm/tools";
import type { Session } from "@arterm/tui";

export interface SessionOptions {
  config: ArtermConfig;
  providerId?: string;
  model?: string;
  yolo?: boolean;
  /** Re-prompt for destructive tools even in auto/yolo (overrides config). */
  confirmDestructive?: boolean;
  cwd: string;
  /** Seed the agent's history (e.g. resuming a recorded session). */
  initialMessages?: Message[];
}

/** Builds the wired-up session (agent + provider + tools + permissions) for the TUI. */
export async function buildSession(opts: SessionOptions): Promise<{
  session: Session;
  persist: () => Promise<void>;
  /** Digest this session's activity into persistent memory (call at session end). */
  digest: () => Promise<void>;
}> {
  const { config, cwd } = opts;
  const providerId = opts.providerId ?? config.provider;
  const model = opts.model ?? config.model;

  // Reassignable: /login swaps the active provider in place. The closures below
  // (sub-agent spawn, summarize, listModels) read this binding at call time, so
  // a switch propagates to all of them.
  let provider = createProvider(config, providerId);
  const initialMode: PermissionMode = opts.yolo ? "yolo" : (config.mode ?? "ask");
  const arbiter = config.arbiter?.enabled === false ? undefined : new RiskArbiter();
  const confirmDestructive = opts.confirmDestructive ?? config.confirmDestructive ?? false;
  const permissions = new PermissionManager(
    config.permissions,
    initialMode,
    arbiter,
    confirmDestructive,
  );
  const bus = new EventBus();

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
      summarize: summarizeWith(config.memory?.summarizeModel),
      embedHost: config.ollamaHost,
    });
    cmem.attach(bus);
  }

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

  // The TUI installs the real asker; until then deny by default.
  let asker: PermissionAsker = async () => "deny";

  const agent = new Agent({
    provider,
    model,
    tools: defaultTools(),
    permissions: container.resolve(Tokens.PermissionPolicy),
    ask: (tool, args) => asker(tool, args),
    bus: container.resolve(Tokens.Bus),
    cwd,
    initialMessages: opts.initialMessages,
    temperature: config.temperature,
    context: container.resolve(Tokens.Compactor),
    contextWindow: config.context?.window,
    compactAtPercent: config.context?.compactAtPercent,
    recall: recallFn,
    container,
  });

  // Sub-agent delegation: the main agent gets a `spawn` tool that runs a fresh
  // sub-agent (own history, the core tool set, no `spawn` of its own → one level
  // deep) toward a task and returns its result.
  const spawnFn = async (task: string, role?: string): Promise<string> => {
    bus.emit({ type: "subagent_start", task, role });
    const output = await runSubagent(task, {
      provider,
      model: agent.model,
      tools: defaultTools(),
      permissions,
      ask: (tool, args) => asker(tool, args),
      cwd,
      taskDone: taskDoneTool,
      context: createContextStrategy(config),
      maxSteps: config.autonomy?.maxSteps,
      role,
    });
    bus.emit({ type: "subagent_done", output });
    return output;
  };

  // Parallel fan-out: run several independent sub-tasks concurrently. Threaded with
  // an optional abort signal so the autonomy engine can cancel an in-flight round.
  const runFleetTasks = async (tasks: { task: string; role?: string }[], signal?: AbortSignal) => {
    bus.emit({ type: "fleet_start", count: tasks.length });
    const results = await runFleet(
      tasks,
      {
        provider,
        model: agent.model,
        tools: defaultTools(),
        permissions,
        ask: (tool, args) => asker(tool, args),
        cwd,
        taskDone: taskDoneTool,
        context: createContextStrategy(config),
        maxSteps: config.autonomy?.maxSteps,
        concurrency: config.fleet?.concurrency,
        isolation: config.fleet?.isolation ?? "none",
        onStart: (_i, task, role) => bus.emit({ type: "subagent_start", task, role }),
        onDone: (_i, output) => bus.emit({ type: "subagent_done", output }),
        onWorktree: (_i, info) => bus.emit({ type: "fleet_worktree", ...info }),
      },
      signal,
    );
    bus.emit({ type: "fleet_done", count: results.length });
    return results.map((r) => ({ task: r.task, role: r.role, output: r.output }));
  };

  // The `spawn_parallel` tool form (no abort signal; the model drives it).
  const fleetFn = (tasks: { task: string; role?: string }[]) =>
    runFleetTasks(tasks).then((rs) => rs.map((r) => ({ task: r.task, output: r.output })));

  agent.setTools([
    ...agent.tools,
    createSpawnTool(spawnFn),
    createSpawnParallelTool(fleetFn),
    ...(cmem
      ? cmem.tools()
      : memoryEnabled
        ? [createMemorySearchTool(memoryStore), createRememberTool(memoryStore)]
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

  const autonomy = new AutonomyEngine(agent, bus, taskDoneTool, {
    mode: config.autonomy?.mode ?? "once",
    maxSteps: config.autonomy?.maxSteps,
    maxPhases: config.autonomy?.maxPhases,
    fanout: config.autonomy?.phasedFanout ?? config.fleet?.concurrency,
    runFleet: (tasks, signal) => runFleetTasks(tasks, signal),
  });

  const sdd = new SddRunner(
    agent,
    bus,
    (tasks, signal) => runFleetTasks(tasks, signal),
    createSddStore(),
    {
      maxQuestions: config.sdd?.maxQuestions,
      maxTasks: config.sdd?.maxTasks,
      fanout: config.fleet?.concurrency,
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
    agent,
    bus,
    config,
    get providerLabel() {
      return provider.id;
    },
    toolCount: agent.tools.length,
    yolo: opts.yolo ?? false,
    setAsker(next) {
      asker = next;
    },
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
      provider = createProvider(config, id);
      agent.setProvider(provider);
      config.provider = id;
    },
    setApiKey(name, key) {
      persistApiKey(name, key);
    },
    removeApiKey(name) {
      removeApiKey(name);
    },
    signedInProviders: () => storedKeyNames(),
    loginProviders: [...providerCatalog],
    compact: () => agent.compact("manual"),
    permissionMode: initialMode,
    setMode(next) {
      permissions.setMode(next);
      config.mode = next;
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
    config.provider = provider.id;
    config.permissions = permissions.snapshot();
    // Persist auto/plan/ask as the default, but never make yolo sticky.
    const current = permissions.getMode();
    config.mode = current === "yolo" ? "ask" : current;
    await saveConfig(config);
  };

  return { session, persist, digest };
}
