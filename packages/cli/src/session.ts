import {
  Agent,
  type AgentEvent,
  type ArtermConfig,
  AutonomyEngine,
  type AutonomyTask,
  Blackboard,
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
  type Tool,
  applyPatch,
  createContextStrategy,
  createMemoryStore,
  createPipelines,
  createSddStore,
  digest as digestObservations,
  estimateTokens,
  formatMemorySection,
  loadConfig,
  memberIsolation,
  runFleet,
  runSubagent,
  saveConfig,
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
} from "@arterm/providers";
import {
  createMemorySearchTool,
  createRememberTool,
  createSpawnParallelTool,
  createSpawnTool,
  defaultTools,
  makeMessageTool,
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

  // Live sub-agent tool set, read from `agent.tools` at spawn time — after main.ts
  // has folded in MCP/plugin tools, so sub-agents inherit them. The delegation
  // tools stay out (depth is one level), and an optional allowlist narrows the set
  // (team members with a `tools:` frontmatter list).
  const subagentTools = (allow?: string[]): Tool[] =>
    agent.tools.filter(
      (t) =>
        t.name !== "spawn" && t.name !== "spawn_parallel" && (!allow || allow.includes(t.name)),
    );

  // Sub-agent delegation: the main agent gets a `spawn` tool that runs a fresh
  // sub-agent (own history, the core tool set, no `spawn` of its own → one level
  // deep) toward a task and returns its result.
  const spawnFn = async (task: string, role?: string): Promise<string> => {
    bus.emit({ type: "subagent_start", task, role });
    const output = await runSubagent(task, {
      provider,
      model: agent.model,
      tools: subagentTools(),
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

  // Team blackboard: a shared space members read/write across rounds (breaks the
  // star topology). Disabled → pure leader-only aggregation. Same instance is
  // handed to the engine (result-posting + brief injection) and to each member's
  // `message` tool below.
  const blackboard = config.team?.blackboard === false ? undefined : new Blackboard();

  // Parallel fan-out: run several independent sub-tasks concurrently. Team tasks
  // (those carrying a member id) additionally get per-member tools + isolation, an
  // id-tagged event bridge to the shared bus, and patch auto-apply per
  // config.team.mergeStrategy once the round returns.
  const runFleetTasks = async (tasks: AutonomyTask[], signal?: AbortSignal) => {
    bus.emit({ type: "fleet_start", count: tasks.length });
    const teamRun = tasks.some((t) => t.id);
    const isolationMode = config.team?.isolation ?? "auto";
    const fleetTasks = tasks.map((t) => {
      if (!t.id) return { task: t.task, role: t.role };
      const id = t.id;
      const memberTools = subagentTools(t.toolNames);
      // Team members always get a `message` tool (independent of their allowlist)
      // so they can post to / address teammates on the shared board.
      if (blackboard) {
        memberTools.push(
          makeMessageTool({ board: blackboard, selfId: id, selfName: t.role ?? "member", bus }),
        );
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
        onEvent: (e: AgentEvent) =>
          bus.emit({ type: "team_member_event", id, name: t.role ?? "member", event: e }),
      };
    });
    const results = await runFleet(
      fleetTasks,
      {
        provider,
        model: agent.model,
        tools: subagentTools(),
        permissions,
        ask: (tool, args) => asker(tool, args),
        cwd,
        taskDone: taskDoneTool,
        context: createContextStrategy(config),
        maxSteps: config.autonomy?.maxSteps,
        concurrency: config.fleet?.concurrency,
        isolation: config.fleet?.isolation ?? "none",
        onStart: (i, task, role) => {
          bus.emit({ type: "subagent_start", task, role });
          const t = tasks[i];
          if (t?.id) {
            bus.emit({
              type: "team_member_state",
              id: t.id,
              name: t.role ?? "member",
              state: "running",
              task: t.task,
            });
          }
        },
        onDone: (i, output, result) => {
          bus.emit({ type: "subagent_done", output });
          const t = tasks[i];
          if (t?.id) {
            bus.emit({
              type: "team_member_state",
              id: t.id,
              name: t.role ?? "member",
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
    teamFanout: config.team?.fanout,
    teamRounds: config.team?.maxRounds,
    runFleet: (tasks, signal) => runFleetTasks(tasks, signal),
    blackboard,
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
      provider = createProvider(config, "openai-compat");
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

  return { session, persist, digest };
}
