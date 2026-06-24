import {
  Agent,
  type ArtermConfig,
  AutonomyEngine,
  EventBus,
  MemoryRecorder,
  type PermissionAsker,
  PermissionManager,
  type PermissionMode,
  RiskArbiter,
  createContextStrategy,
  createMemoryStore,
  digest as digestObservations,
  formatMemorySection,
  runFleet,
  runSubagent,
  saveConfig,
} from "@arterm/core";
import { createProvider } from "@arterm/providers";
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
  cwd: string;
}

/** Builds the wired-up session (agent + provider + tools + permissions) for the TUI. */
export function buildSession(opts: SessionOptions): {
  session: Session;
  persist: () => Promise<void>;
  /** Digest this session's activity into persistent memory (call at session end). */
  digest: () => Promise<void>;
} {
  const { config, cwd } = opts;
  const providerId = opts.providerId ?? config.provider;
  const model = opts.model ?? config.model;

  const provider = createProvider(config, providerId);
  const initialMode: PermissionMode = opts.yolo ? "yolo" : (config.mode ?? "ask");
  const arbiter = config.arbiter?.enabled === false ? undefined : new RiskArbiter();
  const permissions = new PermissionManager(config.permissions, initialMode, arbiter);
  const bus = new EventBus();

  // Persistent, project-scoped memory: capture this session's activity off the
  // bus, recall prior learnings into the system prompt, digest at session end.
  const memoryStore = createMemoryStore(config, cwd);
  const memoryEnabled = memoryStore.id !== "off";
  const recorder = new MemoryRecorder();
  if (memoryEnabled) recorder.attach(bus);
  const maxInject = config.memory?.maxInject ?? 12;

  // The TUI installs the real asker; until then deny by default.
  let asker: PermissionAsker = async () => "deny";

  const agent = new Agent({
    provider,
    model,
    tools: defaultTools(),
    permissions,
    ask: (tool, args) => asker(tool, args),
    bus,
    cwd,
    temperature: config.temperature,
    context: createContextStrategy(config),
    contextWindow: config.context?.window,
    compactAtPercent: config.context?.compactAtPercent,
    recall: memoryEnabled
      ? async () => formatMemorySection(await memoryStore.recent(maxInject))
      : undefined,
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

  // Parallel fan-out: run several independent sub-tasks concurrently.
  const fleetFn = async (tasks: { task: string; role?: string }[]) => {
    bus.emit({ type: "fleet_start", count: tasks.length });
    const results = await runFleet(tasks, {
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
      onStart: (_i, task, role) => bus.emit({ type: "subagent_start", task, role }),
      onDone: (_i, output) => bus.emit({ type: "subagent_done", output }),
    });
    bus.emit({ type: "fleet_done", count: results.length });
    return results.map((r) => ({ task: r.task, output: r.output }));
  };

  agent.setTools([
    ...agent.tools,
    createSpawnTool(spawnFn),
    createSpawnParallelTool(fleetFn),
    ...(memoryEnabled
      ? [createMemorySearchTool(memoryStore), createRememberTool(memoryStore)]
      : []),
  ]);

  // End-of-session digest: compress buffered activity into durable learnings via
  // a quiet, tool-free single-shot model call (Arterm's claude-mem "worker").
  const summarize = async (prompt: string): Promise<string> => {
    let text = "";
    for await (const chunk of provider.chat({
      model: agent.model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
    })) {
      if (chunk.type === "text") text += chunk.delta;
    }
    return text;
  };

  // Single-flight: a periodic digest and the end-of-session digest must never run
  // concurrently (they share the buffer and the model).
  let digesting = false;
  const digest = async (): Promise<void> => {
    if (!memoryEnabled || config.memory?.autoDigest === false || digesting) return;
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
  if (memoryEnabled && config.memory?.autoDigest !== false && digestEvery > 0) {
    recorder.setAutoFlush(digestEvery, () => {
      void digest();
    });
  }

  const autonomy = new AutonomyEngine(agent, bus, taskDoneTool, {
    mode: config.autonomy?.mode ?? "once",
    maxSteps: config.autonomy?.maxSteps,
  });

  const session: Session = {
    agent,
    bus,
    config,
    providerLabel: provider.id,
    toolCount: agent.tools.length,
    yolo: opts.yolo ?? false,
    setAsker(next) {
      asker = next;
    },
    listModels: () => provider.listModels(),
    switchModel(next) {
      agent.setModel(next);
      config.model = next;
    },
    compact: () => agent.compact("manual"),
    permissionMode: initialMode,
    setMode(next) {
      permissions.setMode(next);
      config.mode = next;
    },
    autonomy,
    mcpServers: [],
    plugins: [],
    skills: [],
    getSkillBody: () => undefined,
  };

  const persist = async () => {
    config.provider = providerId;
    config.permissions = permissions.snapshot();
    // Persist auto/plan/ask as the default, but never make yolo sticky.
    const current = permissions.getMode();
    config.mode = current === "yolo" ? "ask" : current;
    await saveConfig(config);
  };

  return { session, persist, digest };
}
