import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ARTERM_HOME,
  type ArtermConfig,
  type AutonomyMode,
  type AutonomySnapshot,
  type CatalogModel,
  type EventBus,
  Keystore,
  type Message,
  SESSIONS_DIR,
  type SessionStore,
  type SessionSummary,
  createSessionStore,
  fetchCatalog,
  findModelById,
  loadConfig,
  projectKey,
  pruneDirByAge,
  readProjectRecords,
  registerAgentDefinitions,
  retentionFromConfig,
  spoolDir,
} from "@arterm/core";
import { formatObservationsText, openMemStore, startCmemMcpServer } from "@arterm/memory";
import {
  LlamaCppProvider,
  OllamaProvider,
  type OpenAICompatProvider,
  allProviders,
  buildAuthorizeUrl,
  createPkce,
  createProvider,
  createState,
  exchangeCode,
  hasCredentials,
  oauthConfigFor,
  oauthProviderIds,
  parseCallbackCode,
  providerCatalog,
  removeOAuthTokens,
  setOAuthTokens,
} from "@arterm/providers";
import {
  AgentDefLoader,
  McpManager,
  PluginLoader,
  SkillRegistry,
  createMcpUseTool,
  createSkillTool,
  startMemoryMcpServer,
} from "@arterm/tools";
import type { Session } from "@arterm/tui";
import { Command } from "commander";
import { openBrowser } from "./browser.js";
import { runChronicleList, runChronicleShow, runChronicleVerify } from "./chronicleCmd.js";
import { CHRONICLE_DIR } from "./chronicleStore.js";
import { ArtermUserError } from "./errors.js";
import { applyAutonomousProfile, printedPrompt } from "./flags.js";
import { runHeadless, runHeadlessGoal } from "./headless.js";
import { runInit } from "./init.js";
import { runMcpServe } from "./mcpServe.js";
import { formatRecordsText, startCmemServer, startMemoryServer } from "./memoryServer.js";
import { runPermissionsExplain } from "./permissionsExplain.js";
import { formatList, listPermissions, parseOnly, runPermissionsList } from "./permissionsList.js";
import { buildSession } from "./session.js";
import { type CliManagedSession, SessionManager } from "./sessionManager.js";
import { runStatus } from "./status.js";
import { type StatusServer, shouldPublish, startStatusServer } from "./statusServer.js";
import { runToolsCost } from "./toolsCost.js";
import { isKnownProvider, parsePort, unknownProviderMessage } from "./validate.js";

const VERSION = "0.9.1";

/** Provider ids the CLI can build — the single source of truth for `--provider`. */
const PROVIDER_IDS: readonly string[] = providerCatalog.map((p) => p.id);

/** Throw a clean error if `id` isn't a provider the CLI knows how to build. */
function requireKnownProvider(id: string): void {
  if (!isKnownProvider(id, PROVIDER_IDS)) {
    throw new ArtermUserError(unknownProviderMessage(id, PROVIDER_IDS));
  }
}

/** The most-recently-started session id from a list of summaries. */
function newestSessionId(sessions: SessionSummary[]): string {
  return [...sessions].sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""))[0]!.id;
}

/**
 * Resolve the conversation to seed when `--resume`/`--continue` is given, or
 * `undefined` for a fresh session. Errors actionably when there's nothing to
 * resume (logging off, no sessions, or an unknown id).
 */
async function resolveResumeMessages(
  store: SessionStore,
  globals: GlobalOpts,
): Promise<{ id: string; messages: Message[] } | undefined> {
  if (!globals.resume && !globals.continue) return undefined;

  let id = globals.resume;
  if (!id) {
    const sessions = await store.list();
    if (sessions.length === 0) {
      throw new ArtermUserError(
        'No recorded sessions to continue. Enable logging with session.mode "jsonl" in your config.',
      );
    }
    id = newestSessionId(sessions);
  }

  const messages = await store.load(id);
  if (messages.length === 0) {
    throw new ArtermUserError(
      `No recorded session "${id}" (or it has no messages). Run \`arterm sessions\` to list ids.`,
    );
  }
  // Status line on stderr so it never dirties stdout (esp. headless --json).
  process.stderr.write(`↻ resumed session ${id} (${messages.length} messages)\n`);
  return { id, messages };
}

/** Path of a session's autonomy crash-recovery checkpoint (next to its transcript). */
function autonomyCheckpointPath(sessionId: string): string {
  return join(SESSIONS_DIR, `${sessionId}.autonomy.json`);
}

/**
 * Read (and consume) the autonomy checkpoint a resumed session may have left
 * behind. Consuming it keeps a stale goal from being re-announced forever; the
 * new session writes its own checkpoint the moment a goal starts.
 */
async function takeAutonomyCheckpoint(
  sessionId: string,
): Promise<{ goal: string; mode: AutonomyMode; step: number; savedAt?: number } | undefined> {
  const path = autonomyCheckpointPath(sessionId);
  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as {
      goal?: string;
      mode?: AutonomyMode;
      step?: number;
      savedAt?: number;
    };
    await rm(path, { force: true });
    if (!raw.goal) return undefined;
    return { goal: raw.goal, mode: raw.mode ?? "once", step: raw.step ?? 0, savedAt: raw.savedAt };
  } catch {
    return undefined; // no checkpoint (or unreadable) — nothing to surface
  }
}

interface GlobalOpts {
  provider?: string;
  model?: string;
  yolo?: boolean;
  confirmDestructive?: boolean;
  goal?: string;
  /**
   * One-shot prompt; runs headlessly (no TUI) and prints the result. The value
   * is optional, so a bare `--print` (e.g. `--print --json` with the prompt on
   * stdin) arrives as `true` rather than a string.
   */
  print?: string | true;
  /** With --print/piped input, emit the result as a single JSON object. */
  json?: boolean;
  /** Resume a recorded session by id. */
  resume?: string;
  /** Resume the most recent recorded session. */
  continue?: boolean;
  /** Pin the desktop status server port (implies enabled). */
  statusPort?: string;
  /** False when --no-status-server was passed (commander negated boolean). */
  statusServer?: boolean;
  /** Standing verification command for this run (config `verify.command`). */
  verifyCmd?: string;
  /** Keep working past the rejection cap (config `verify.persist`). */
  persist?: boolean;
  /** Unattended profile: yolo + verify-persist + sub-agent auto-approve + auto-extend. */
  autonomous?: boolean;
  /** Autonomy mode for this run (once | eternal | parallel | phased | team). */
  autonomyMode?: string;
  /** Step-cap override; with eternal mode, a hard bound (CI/testing hook). */
  maxSteps?: string;
  /** Whole-run token ceiling; the run stops rather than paying past it. */
  maxTokens?: string;
  /** Whole-run USD ceiling. */
  maxUsd?: string;
  /** Whole-run wall-clock ceiling, in seconds. */
  maxDuration?: string;
  /** Roster size for this run, overriding config `tools.tier`. */
  toolsTier?: string;
  /** `--sandbox` / `--no-sandbox`; undefined means unstated (see `flags.ts`). */
  sandbox?: boolean;
}

/**
 * Overlay the run's verification flags onto the loaded config.
 *
 * `verify.command` deliberately has a flag as well as a config field, because
 * config is global (`~/.arterm/config.json`) and a command is not: `pnpm -r test`
 * as a standing gate is correct in this repo and fails closed in every directory
 * that has no pnpm, blocking completion claims that were fine. Per-run is the
 * honest default for it; the config field is for someone who lives in one repo.
 */
function applyVerifyFlags(config: ArtermConfig, globals: GlobalOpts): ArtermConfig {
  if (globals.verifyCmd === undefined && !globals.persist) return config;
  config.verify = {
    ...config.verify,
    ...(globals.verifyCmd !== undefined ? { command: globals.verifyCmd } : {}),
    ...(globals.persist ? { persist: true } : {}),
  };
  return config;
}

/**
 * Start the desktop status server when enabled (docs/desktop-integration.md).
 * Precedence: --no-status-server > --status-port (implies on) > config.statusServer,
 * whose "auto" default publishes every interactive session regardless of terminal
 * — see `shouldPublish`. Failure warns and never blocks startup.
 */
async function maybeStartStatusServer(
  session: Session,
  config: ArtermConfig,
  globals: GlobalOpts,
  opts?: { sessionId?: string; allowPinnedPort?: boolean; interactive?: boolean },
): Promise<StatusServer | undefined> {
  if (globals.statusServer === false) return undefined;
  let pinned: number | undefined;
  if (globals.statusPort !== undefined) {
    pinned = Number(globals.statusPort);
    if (!Number.isInteger(pinned) || pinned < 0 || pinned > 65535) {
      process.stderr.write(
        `⚠ invalid --status-port "${globals.statusPort}" — status server disabled\n`,
      );
      return undefined;
    }
  }
  const on = shouldPublish({
    enabled: config.statusServer?.enabled ?? "auto",
    interactive: opts?.interactive ?? false,
    pinnedPort: pinned !== undefined,
  });
  if (!on) return undefined;
  // A pinned port can only serve one session; later sessions always bind port 0.
  const allowPinned = opts?.allowPinnedPort ?? true;
  try {
    return await startStatusServer({
      session,
      cwd: process.cwd(),
      port: allowPinned ? (pinned ?? config.statusServer?.port ?? 0) : 0,
      sessionId: opts?.sessionId,
    });
  } catch (err) {
    process.stderr.write(`⚠ status server failed to start: ${(err as Error).message}\n`);
    return undefined;
  }
}

/**
 * Startup preflight for the selected provider — warns (never blocks) before the
 * first turn fails. Each backend fails differently, so the check branches by type:
 * hosted/key-based providers need an API key (checked offline, no ping); local-server
 * providers (Ollama, a custom OpenAI-compatible host) need a reachable endpoint;
 * llama.cpp needs a .gguf in the models dir. Returns a warning line, or undefined.
 */
async function preflight(providerId: string, config: ArtermConfig): Promise<string | undefined> {
  // Hosted, key-based backends: the common first-run failure is a missing key, not
  // an unreachable host — so check the key (instant, offline) instead of pinging.
  if (providerCatalog.find((p) => p.id === providerId)?.needsKey) {
    if (hasCredentials(providerId)) return undefined;
    const oauthHint = oauthProviderIds.includes(providerId)
      ? `, or sign in with \`arterm login ${providerId}\``
      : "";
    return `No credentials for "${providerId}". Add a key with \`arterm auth set ${providerId}\`${oauthHint}, or set its *_API_KEY env var.`;
  }

  switch (providerId) {
    case "ollama": {
      const ok = await new OllamaProvider({ host: config.ollamaHost }).isReachable();
      return ok
        ? undefined
        : `Ollama not reachable at ${config.ollamaHost}. Start it with \`ollama serve\`, or switch provider with --provider llamacpp.`;
    }
    // openai-compat is probed in the BACKGROUND (probeCompatHostInBackground): the
    // host is usually remote, and a synchronous WAN round-trip here cost ~1s of
    // startup. An unreachable host surfaces as a TUI warning line instead.
    case "llamacpp": {
      const models = await new LlamaCppProvider({ modelsDir: config.modelsDir }).listModels();
      return models.length > 0
        ? undefined
        : `No .gguf models found in ${config.modelsDir}. Put a model file there, or switch provider with --provider ollama.`;
    }
    default:
      return undefined;
  }
}

/**
 * Fire-and-forget reachability probe for the (usually remote) OpenAI-compatible
 * host. Runs off the startup path — the probe carries the same stored key and
 * custom headers as real chat, and an unreachable host is reported as a warning
 * line on the session bus. The emit is delayed so the TUI (which subscribes on
 * mount, with no event replay) is guaranteed to be listening by then.
 */
function probeCompatHostInBackground(
  providerId: string,
  config: ArtermConfig,
  bus: EventBus,
): void {
  if (providerId !== "openai-compat") return;
  const provider = createProvider(config, "openai-compat") as OpenAICompatProvider;
  const started = Date.now();
  void provider
    .isReachable()
    .then((ok) => {
      if (ok) return;
      const wait = Math.max(0, 1_500 - (Date.now() - started));
      setTimeout(() => {
        bus.emit({
          type: "error",
          error: `OpenAI-compatible host not reachable at ${config.openaiCompatHost}. Check the host or that the server is running.`,
        });
      }, wait).unref();
    })
    .catch(() => {});
}

/**
 * Age out the flat stores nothing else bounds: the spool and the chronicle.
 *
 * Called from BOTH bootstraps (`startChat`, `runHeadlessFlow`), because the
 * catalog warming two paragraphs below each call is the documented lesson: a
 * best-effort helper wired into one path is simply off in the other, and
 * headless is where the spool actually grew. Never awaited and never fatal —
 * a store that cannot be pruned must not cost a session its startup — with
 * `ARTERM_DEBUG` as the only witness, same as the transcript prune.
 */
function pruneHomeArtifacts(config: ArtermConfig): void {
  const debug = (what: string) => (err: unknown) => {
    if (process.env.ARTERM_DEBUG) {
      process.stderr.write(`⚠ ${what} prune failed: ${(err as Error).message}\n`);
    }
    return [] as string[];
  };
  void pruneDirByAge(spoolDir(), config.retention?.spoolDays).catch(debug("spool"));
  void pruneDirByAge(CHRONICLE_DIR, config.retention?.chronicleDays).catch(debug("chronicle"));
}

async function startChat(globals: GlobalOpts): Promise<void> {
  const config = applyVerifyFlags(await loadConfig(), globals);
  const { hardCap } = applyAutonomousProfile(config, globals);
  const providerId = globals.provider ?? config.provider;
  requireKnownProvider(providerId);

  // Warm the models.dev cache in the background so `supportsNativeTools` can use
  // authoritative tool-call data this session. Best-effort: cached/offline → no-op.
  if (config.catalog?.enabled !== false) {
    const ttlMs = (config.catalog?.maxAgeHours ?? 24) * 60 * 60 * 1000;
    void fetchCatalog({ ttlMs }).catch(() => {});
  }

  const warning = await preflight(providerId, config);
  if (warning) process.stdout.write(`⚠ ${warning}\n`);

  // Open the transcript store first: resuming seeds the agent from a prior session.
  // With session.mode "off" (the default) this stays empty and nothing hits disk.
  const store = createSessionStore(config);
  const resumed = await resolveResumeMessages(store, globals);
  const initialMessages = resumed?.messages;

  // Trim the ageing stores nothing else bounds — the spool grew to 39MB in
  // three weeks without this. Fire-and-forget: unlike the transcript prune
  // below, no store handle is about to be opened over these.
  void pruneHomeArtifacts(config);

  // Trim old transcripts (best-effort) before any session opens a store handle.
  try {
    await store.prune(retentionFromConfig(config));
  } catch (err) {
    // Pruning must never block startup; surface it only under ARTERM_DEBUG.
    if (process.env.ARTERM_DEBUG) {
      process.stderr.write(`⚠ session prune failed: ${(err as Error).message}\n`);
    }
  }

  // Load external capabilities once: MCP servers, local plugins, and skills.
  const mcp = new McpManager(config.mcpServers);
  const pluginTrust = Object.fromEntries(
    Object.entries(config.plugins ?? {}).map(([name, p]) => [name, p.trust]),
  );
  const plugins = new PluginLoader(join(ARTERM_HOME, "plugins"), pluginTrust);
  const skills = new SkillRegistry(join(ARTERM_HOME, "skills"));
  // Agent definitions for /team and /agents: project files win over global ones.
  const agentDefs = new AgentDefLoader(
    join(process.cwd(), ".arterm", "agents"),
    join(ARTERM_HOME, "agents"),
  );

  const [mcpTools, pluginTools] = await Promise.all([mcp.connect(), plugins.load()]);
  await skills.load();
  registerAgentDefinitions(await agentDefs.load());

  // Apply the shared extension set to a session — called once per session, so
  // every concurrently running session sees the same MCP/plugin/skill surface.
  const enrichSession = (session: Session): void => {
    session.agentDefs = agentDefs.summary;

    // Fold external tools into the agent (built-ins win on name collisions).
    // The `skill` tool joins them here rather than in `buildSession`, because
    // the registry it reads is loaded HERE — a session-level copy would be a
    // second registry answering from a different directory.
    const existing = new Set(session.agent.tools.map((t) => t.name));
    const extra = [
      createSkillTool(skills),
      // Lazy access to servers that are configured but NOT eagerly connected.
      // `isConnected` is what keeps it from opening a second child process for
      // a server whose tools are already on the roster above.
      createMcpUseTool({
        servers: config.mcpServers ?? {},
        isConnected: (name) => mcp.summary.some((s) => s.name === name && s.status === "connected"),
      }),
      ...mcpTools,
      ...pluginTools,
    ].filter((t) => !existing.has(t.name));
    if (extra.length > 0) {
      session.agent.setTools([...session.agent.tools, ...extra]);
      session.toolCount = session.agent.tools.length;
    }
    session.agent.setSkills(skills.list());
    session.mcpServers = mcp.summary;
    session.plugins = plugins.summary;
    session.skills = skills.list();
    session.getSkillBody = (name) => skills.get(name)?.body;

    // `/permissions` is wired here rather than in buildSession because only this
    // scope knows which tool came from where — and "this name arrived from a
    // plugin" is the single most useful column in that table.
    const mcpNames = new Set(mcpTools.map((t) => t.name));
    const pluginNames = new Set(pluginTools.map((t) => t.name));
    session.permissionsTable = (opts = {}) => {
      // Read `agent.tools` at call time: a /mcp reload can add tools mid-session,
      // and a stale snapshot would quietly under-report what the agent can do.
      const entries = session.agent.tools.map((tool) => ({
        tool,
        source: mcpNames.has(tool.name)
          ? ("mcp" as const)
          : pluginNames.has(tool.name)
            ? ("plugin" as const)
            : ("built-in" as const),
      }));
      const only = parseOnly(opts.only);
      // Default to the LIVE session mode, not `config.mode` — `--yolo` and
      // Shift+Tab never touch the config, so config-derived rows would describe
      // a stricter session than the one actually running.
      return formatList(
        listPermissions(session.config, entries, {
          mode: opts.mode ?? session.permissionMode,
          ...(only ? { only } : {}),
        }),
      );
    };

    // Live health checks + reload for /mcp and /plugins (the TUI only sees the
    // summaries above; these closures give it the live manager instances).
    session.checkExtensions = async () => ({
      mcp: await mcp.check(),
      plugins: await plugins.check(),
    });
    session.reloadExtensions = async () => {
      const [mcpTools, pluginTools] = await Promise.all([mcp.reconnect(), plugins.reload()]);
      // Re-scan agent definitions too, so /team picks up new .md files without a restart.
      registerAgentDefinitions(await agentDefs.load());
      session.agentDefs = agentDefs.summary;
      // Same collision rule as startup: whatever is already registered wins.
      const have = new Set(session.agent.tools.map((t) => t.name));
      const added = [...mcpTools, ...pluginTools].filter((t) => !have.has(t.name));
      if (added.length > 0) {
        session.agent.setTools([...session.agent.tools, ...added]);
        session.toolCount = session.agent.tools.length;
      }
      return {
        mcp: mcp.summary,
        plugins: plugins.summary,
        addedTools: added.map((t) => t.name),
      };
    };
  };

  // Session factory: each session gets its own config clone (switchModel/
  // switchProvider mutate it in place), store handle, and status server —
  // one discovery file per session keeps the desktop dashboard accurate.
  let firstSession = true;
  const makeSession = async (): Promise<CliManagedSession> => {
    const isFirst = firstSession;
    firstSession = false;
    const cfg = structuredClone(config);
    const { session, persist, digest, setAutonomyCheckpointSink } = await buildSession({
      config: cfg,
      providerId: globals.provider,
      model: globals.model,
      yolo: globals.yolo,
      confirmDestructive: globals.confirmDestructive,
      hardCap,
      cwd: process.cwd(),
      // The TUI has someone at the keyboard even when the run is autonomous —
      // an unavailable sandbox can be reported and answered here, which is
      // exactly what the headless path below cannot do.
      unattended: false,
      initialMessages: isFirst ? initialMessages : undefined,
    });

    // Log messages incrementally as they're produced, so in-memory context
    // compaction never loses the on-disk record.
    const handle = await store.create({ model: cfg.model, provider: providerId });
    session.agent.setOnMessage((message) => handle.logMessage(message));

    // Crash recovery: mirror the autonomy engine's progress into a checkpoint
    // file next to the transcript. Cleared by the engine on task_done / user
    // stop; a crash leaves it behind for the next --resume to surface.
    if (cfg.session?.mode === "jsonl") {
      const ckptPath = autonomyCheckpointPath(handle.id);
      setAutonomyCheckpointSink(async (snap: AutonomySnapshot | null) => {
        if (snap === null) await rm(ckptPath, { force: true });
        else await writeFile(ckptPath, JSON.stringify({ ...snap, savedAt: Date.now() }), "utf8");
      });
    }

    enrichSession(session);
    const id = randomUUID();
    const statusServer = await maybeStartStatusServer(session, cfg, globals, {
      sessionId: id,
      allowPinnedPort: isFirst,
      interactive: true,
    });
    return { id, session, statusServer, persist, digest };
  };

  for (const s of mcp.summary) {
    if (s.status === "failed") {
      process.stdout.write(`⚠ MCP server "${s.name}" failed to connect: ${s.error}\n`);
    }
  }
  for (const p of plugins.summary) {
    if (p.status === "failed") {
      process.stdout.write(`⚠ plugin "${p.name}" failed to load: ${p.error}\n`);
    }
  }

  const first = await makeSession();
  const manager = new SessionManager(first, makeSession);

  // Remote-host reachability check runs off the critical path (see the helper) —
  // by now the session bus exists, so a failure can surface inside the TUI.
  probeCompatHostInBackground(providerId, config, first.session.bus);

  // A resumed session may have died mid-goal: surface the leftover autonomy
  // checkpoint inside the TUI (delayed past mount, like the probe above) so the
  // user can relaunch the goal deliberately — never auto-restarted.
  if (resumed) {
    void takeAutonomyCheckpoint(resumed.id).then((ckpt) => {
      if (!ckpt) return;
      setTimeout(() => {
        first.session.bus.emit({ type: "autonomy_resume_available", ...ckpt });
      }, 800);
    });
  }

  // Lazy: ink (and its yoga-layout WASM) costs ~800ms to import — load it only
  // when the TUI is actually about to render, keeping --version/--print fast.
  const { runTui } = await import("@arterm/tui");
  await runTui(
    { id: first.id, session: first.session },
    {
      goal: globals.goal,
      version: VERSION,
      createSession: async () => {
        const s = await manager.create();
        return { id: s.id, session: s.session };
      },
      closeSession: async (id) => {
        await manager.close(id, (err) => {
          if (process.env.ARTERM_DEBUG) {
            process.stderr.write(`⚠ memory digest failed: ${err.message}\n`);
          }
        });
      },
    },
  );

  // Digest every session's activity into persistent memory before exiting.
  await manager.closeAll((err) => {
    // Memory digest must never block a clean shutdown; show it under ARTERM_DEBUG.
    if (process.env.ARTERM_DEBUG) {
      process.stderr.write(`⚠ memory digest failed: ${err.message}\n`);
    }
  });
  await mcp.close();
}

/**
 * One-shot, non-interactive run for scripting/CI: take a prompt from --print or
 * piped stdin, run it to completion without the TUI, print the result, and exit.
 * Unlike `startChat` this skips the preflight banner (it would dirty stdout, and
 * --json output especially) and external capability loading (MCP/plugins/skills)
 * to stay fast and predictable — built-in tools + memory still apply.
 */
async function runHeadlessFlow(globals: GlobalOpts): Promise<void> {
  // `--goal` runs the autonomy loop; `--print`/stdin runs one prompt. When both
  // are given the goal wins, because it is the more specific instruction — and
  // it used to be dropped on the floor here without a word.
  // A bare `--print` (no value) is the flag, not the prompt — see `printedPrompt`.
  const prompt = globals.goal ? "" : (printedPrompt(globals.print) ?? (await readStdin()));
  const config = applyVerifyFlags(await loadConfig(), globals);
  const { hardCap } = applyAutonomousProfile(config, globals);
  const providerId = globals.provider ?? config.provider;
  requireKnownProvider(providerId);

  // Warm the models.dev cache here too, exactly as `startChat` does.
  //
  // It is per-ARTERM_HOME and it was warmed on the TUI path ONLY, so a headless
  // run in a fresh home never had one — `modelContextWindow` returned undefined
  // and the context window fell back to `context.window`'s 8192, a local-GGUF
  // default, for a model whose real window is a million. That is not a corner
  // case: the Harbor benchmark container starts from a fresh home every trial
  // and drives the CLI headlessly, so our own measurements were taken with
  // compaction firing at 6,144 tokens.
  if (config.catalog?.enabled !== false) {
    const ttlMs = (config.catalog?.maxAgeHours ?? 24) * 60 * 60 * 1000;
    // Awaited when there is NO cache, fire-and-forget when it is merely stale.
    // The difference is what the session starts believing: with nothing on disk
    // the window is the 8192 default until the fetch lands, and a run that
    // finishes inside one turn never sees the correction. One bounded request,
    // once per home, buys the right window for every turn after it — and where
    // there is no network it fails the same way it always did, which is the
    // case the boot warning is actually for.
    const warm = fetchCatalog({ ttlMs }).catch(() => []);
    if (!existsSync(join(ARTERM_HOME, "models-dev.json"))) await warm;
  }

  // User-defined agents, exactly as `startChat` loads them — the third instance
  // of the one-bootstrap mistake (the catalog above was the first, the retention
  // prune the second). Headless is where fleets actually run unattended, and a
  // `/team` roster or a `spawn` role defined in `.arterm/agents/` simply did not
  // exist on this path: `availableRoles()` fell back to the five built-ins with
  // no error, which is the "worked in the TUI, silently degraded headless"
  // shape. Best-effort like everything else in this bootstrap.
  try {
    const agentDefs = new AgentDefLoader(
      join(process.cwd(), ".arterm", "agents"),
      join(ARTERM_HOME, "agents"),
    );
    registerAgentDefinitions(await agentDefs.load());
  } catch {
    // A malformed definition dir must not cost a headless run its startup.
  }

  const store = createSessionStore(config);
  const resumed = await resolveResumeMessages(store, globals);

  // Same prune as `startChat`, for the catalog-warming reason: a helper wired
  // into one bootstrap is OFF in the other, and headless runs are where the
  // spool actually accumulated — every probe and benchmark trial writes there.
  void pruneHomeArtifacts(config);

  const { session, persist, digest } = await buildSession({
    config,
    providerId: globals.provider,
    model: globals.model,
    yolo: globals.yolo,
    confirmDestructive: globals.confirmDestructive,
    hardCap,
    cwd: process.cwd(),
    // Headless: no terminal, no prompt, and under --autonomous no supervision
    // at all. This is the run whose sandbox has to fail closed.
    unattended: true,
    initialMessages: resumed?.messages,
  });

  // Record this turn so it's resumable later (no-op when session.mode is "off").
  const handle = await store.create({ model: config.model, provider: providerId });
  session.agent.setOnMessage((message) => handle.logMessage(message));

  const statusServer = await maybeStartStatusServer(session, config, globals);

  try {
    if (globals.goal) {
      await runHeadlessGoal(session, globals.goal, { json: globals.json });
    } else {
      await runHeadless(session, prompt, { json: globals.json });
    }
  } finally {
    await statusServer?.close();
    try {
      await digest();
    } catch (err) {
      if (process.env.ARTERM_DEBUG) {
        process.stderr.write(`⚠ memory digest failed: ${(err as Error).message}\n`);
      }
    }
    await persist();
  }
}

/** Format the catalog facts (context window, pricing) appended to a model line. */
function catalogFacts(meta: CatalogModel | undefined): string {
  if (!meta) return "";
  const facts: string[] = [];
  if (meta.contextWindow) facts.push(`${Math.round(meta.contextWindow / 1000)}k ctx`);
  if (meta.inputCost !== undefined || meta.outputCost !== undefined) {
    facts.push(`$${meta.inputCost ?? 0}/$${meta.outputCost ?? 0} per 1M`);
  }
  return facts.length ? `  ·  ${facts.join("  ·  ")}` : "";
}

async function listModels(): Promise<void> {
  const config = await loadConfig();
  // Best-effort: enrich each model with models.dev metadata. Empty list when offline.
  const catalog = await fetchCatalog().catch(() => [] as CatalogModel[]);
  for (const provider of allProviders(config)) {
    let models: Awaited<ReturnType<typeof provider.listModels>> = [];
    try {
      models = await provider.listModels();
    } catch (err) {
      process.stdout.write(`${provider.id}: (unavailable — ${(err as Error).message})\n`);
      continue;
    }
    process.stdout.write(`${provider.id}:\n`);
    if (models.length === 0) process.stdout.write("  (none)\n");
    for (const m of models) {
      // The provider's own determination already folds in catalog tool data;
      // the catalog meta is just for context-window / pricing facts.
      const meta = findModelById(catalog, m.name, provider.id);
      const tools = m.supportsTools ? " [tools]" : "";
      process.stdout.write(`  ${m.name}${tools}${catalogFacts(meta)}\n`);
    }
  }
}

async function pullModel(model: string): Promise<void> {
  const config = await loadConfig();
  const provider = new OllamaProvider({ host: config.ollamaHost });
  process.stdout.write(`Pulling ${model} …\n`);
  let last = "";
  try {
    for await (const status of provider.pull(model)) {
      if (status !== last) {
        process.stdout.write(`  ${status}\n`);
        last = status;
      }
    }
  } catch (err) {
    throw new ArtermUserError(
      `Failed to pull "${model}" from Ollama at ${config.ollamaHost} ` +
        `(${(err as Error).message}). Is Ollama running? Start it with \`ollama serve\`.`,
    );
  }
  process.stdout.write("Done.\n");
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function authSet(name: string, value?: string): Promise<void> {
  const secret = value ?? (await readStdin());
  if (!secret) {
    process.stderr.write("Provide the secret via --value or pipe it on stdin.\n");
    process.exitCode = 1;
    return;
  }
  Keystore.open().set(name, secret);
  process.stdout.write(`✓ stored encrypted key "${name}"\n`);
}

function authList(): void {
  const names = Keystore.open().names();
  if (names.length === 0) process.stdout.write("No stored keys.\n");
  else process.stdout.write(`Stored keys:\n${names.map((n) => `  ${n}`).join("\n")}\n`);
}

function authRemove(name: string): void {
  const removed = Keystore.open().remove(name);
  process.stdout.write(removed ? `✓ removed "${name}"\n` : `no key named "${name}"\n`);
}

/** Read one line from stdin interactively (for the login code paste). */
async function promptLine(prompt: string): Promise<string> {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(prompt);
  } finally {
    rl.close();
  }
}

/**
 * Subscription (OAuth/PKCE) login: open the provider's authorize page, take the
 * `code#state` the callback hands back, exchange it for tokens, and store them
 * encrypted. Defaults to Anthropic (Claude Pro/Max). The access token is then
 * used as a Bearer credential, auto-refreshed when it expires.
 */
async function runLogin(providerArg?: string): Promise<void> {
  const id = providerArg ?? "anthropic";
  const config = oauthConfigFor(id);
  if (!config) {
    const list = oauthProviderIds.length ? oauthProviderIds.join(", ") : "(none)";
    throw new ArtermUserError(
      `Provider "${id}" doesn't support subscription login. OAuth providers: ${list}. ` +
        `For an API key use \`arterm auth set ${id}\`.`,
    );
  }
  const { verifier, challenge } = createPkce();
  const state = createState();
  const url = buildAuthorizeUrl(config, { challenge, state });
  process.stdout.write(`Opening your browser to sign in to ${id}…\n\n  ${url}\n\n`);
  await openBrowser(url);
  process.stdout.write(
    "After approving, paste the code from the callback page (it looks like `code#state`).\n",
  );
  const pasted = await promptLine("code: ");
  if (!pasted.trim()) throw new ArtermUserError("No code entered; login cancelled.");

  const { code, state: returnedState } = parseCallbackCode(pasted);
  if (returnedState && returnedState !== state) {
    throw new ArtermUserError("State mismatch — login aborted for safety. Please try again.");
  }
  let tokens: Awaited<ReturnType<typeof exchangeCode>>;
  try {
    tokens = await exchangeCode(config, { code, verifier, state: returnedState ?? state });
  } catch (err) {
    throw new ArtermUserError(`Login failed: ${(err as Error).message}`);
  }
  setOAuthTokens(id, tokens);
  process.stdout.write(`✓ signed in to ${id} (subscription) — tokens stored encrypted.\n`);
}

/** Clear a stored subscription (OAuth) session. */
function runLogout(providerArg?: string): void {
  const id = providerArg ?? "anthropic";
  const removed = removeOAuthTokens(id);
  process.stdout.write(removed ? `✓ signed out of ${id}\n` : `not signed in to ${id}\n`);
}

async function memoryServe(opts: { port?: string; open?: boolean }): Promise<void> {
  const port = parsePort(opts.port, 7777);
  if (port === null) {
    throw new ArtermUserError(`Invalid --port "${opts.port}". Use an integer between 1 and 65535.`);
  }
  const cwd = process.cwd();
  const config = await loadConfig();
  const cmem = config.memory?.engine === "cmem" && config.memory?.mode !== "off";
  const server = await (cmem ? startCmemServer : startMemoryServer)({ cwd, port });
  process.stdout.write(
    `Arterm ${cmem ? "cmem" : "memory"} viewer → ${server.url}\nProject: ${cwd}\nPress Ctrl+C to stop.\n`,
  );
  if (opts.open) await openBrowser(server.url);
  await new Promise<void>((resolve) => {
    process.on("SIGINT", () => {
      process.stdout.write("\nStopping memory viewer.\n");
      void server.close().then(resolve);
    });
  });
}

async function memoryList(): Promise<void> {
  const cwd = process.cwd();
  const config = await loadConfig();
  if (config.memory?.engine === "cmem" && config.memory?.mode !== "off") {
    const store = await openMemStore(cwd);
    try {
      process.stdout.write(`${formatObservationsText(await store.all())}\n`);
    } finally {
      store.close();
    }
    return;
  }
  const records = await readProjectRecords(projectKey(cwd));
  process.stdout.write(`${formatRecordsText(records)}\n`);
}

async function listSessionsCmd(): Promise<void> {
  const config = await loadConfig();
  const store = createSessionStore(config);
  const sessions = await store.list();
  if (sessions.length === 0) {
    process.stdout.write(
      'No recorded sessions. Enable logging with session.mode "jsonl" in your config.\n',
    );
    return;
  }
  for (const s of [...sessions].sort((a, b) =>
    (b.startedAt ?? "").localeCompare(a.startedAt ?? ""),
  )) {
    const when = s.startedAt ? new Date(s.startedAt).toLocaleString() : "unknown time";
    process.stdout.write(`${s.id}  ${when}  ${s.provider ?? "?"}/${s.model ?? "?"}\n`);
  }
}

async function main(): Promise<void> {
  const program = new Command();
  program
    .name("arterm")
    .description("Local AI coding agent for your terminal")
    .version(VERSION)
    .option(
      "-p, --provider <id>",
      "provider: ollama | llamacpp | openai-compat | anthropic | openai | gemini | xai | deepseek | groq | openrouter | mistral",
    )
    .option("-m, --model <name>", "model name or .gguf file")
    .option("--yolo", "skip permission prompts (still blocks critical/destructive calls)")
    .option("--confirm-destructive", "always re-prompt before destructive tools, even in auto/yolo")
    .option("--goal <text>", "start an autonomous run toward this goal (add --print for no TUI)")
    // Optional value: `--print "…"` runs that prompt, while a bare `--print`
    // alongside `--goal` just means "no TUI" — otherwise scripting a goal run
    // requires the nonsense of `--print ""`.
    .option("--print [prompt]", "run headlessly (no TUI) and print the result")
    .option("--json", "with --print or piped input, emit the result as JSON")
    .option("--resume <id>", "resume a recorded session by id (see `arterm sessions`)")
    .option("--continue", "resume the most recent recorded session")
    .option("--status-port <port>", "pin the desktop status server port (implies enabled)")
    .option("--no-status-server", "disable the desktop status server")
    .option(
      "--verify-cmd <cmd>",
      'command that must exit 0 before a result is accepted, e.g. "pnpm -r test"',
    )
    .option("--persist", "keep working after the verifier's rejection cap, up to the step limit")
    .option(
      "--autonomous",
      "run unattended: yolo permissions, verify-persist, sub-agent auto-approve, step auto-extend",
    )
    .option(
      "--autonomy-mode <mode>",
      "autonomy mode for this run: once | eternal | parallel | phased | team",
    )
    // `--sandbox` is declared FIRST so commander leaves the default undefined:
    // a lone `--no-sandbox` would otherwise make the option default to true and
    // silently turn the sandbox on for every attended session.
    .option("--sandbox", "confine shell commands to this directory and an egress allowlist")
    .option("--no-sandbox", "run shell commands unconfined, even under --autonomous")
    .option("--max-steps <n>", "override autonomy.maxSteps; with eternal mode, a hard bound")
    .option("--max-tokens <n>", "stop the run after this many tokens (whole run, not per turn)")
    .option("--max-usd <amount>", "stop the run after this much spend, e.g. 2.50")
    .option(
      "--max-duration <seconds>",
      "stop the run after this much wall-clock time; set it below a harness timeout",
    )
    .option(
      "--tools-tier <tier>",
      "roster size for this run: minimal | standard | full (overrides tools.tier)",
    );

  program
    .command("chat", { isDefault: true })
    .description("start an interactive chat session (default)")
    .action(async () => {
      const globals = program.opts<GlobalOpts>();
      // Headless when an explicit prompt is given, or when stdin is piped (so
      // `echo "…" | arterm` works for scripting); otherwise open the TUI.
      if (globals.print !== undefined || !process.stdin.isTTY) {
        await runHeadlessFlow(globals);
      } else {
        await startChat(globals);
      }
    });

  program
    .command("init")
    .description("interactive setup: provider, model, permission mode")
    .action(async () => {
      await runInit();
    });

  program
    .command("models")
    .description("list available models across providers")
    .action(listModels);

  program.command("pull <model>").description("download a model via Ollama").action(pullModel);

  program
    .command("sessions")
    .description("list recorded chat sessions (resume one with --resume <id>)")
    .action(listSessionsCmd);

  program
    .command("login [provider]")
    .description("sign in with a provider subscription via OAuth (default: anthropic)")
    .action(async (provider?: string) => {
      await runLogin(provider);
    });

  program
    .command("logout [provider]")
    .description("clear a stored subscription (OAuth) session (default: anthropic)")
    .action((provider?: string) => {
      runLogout(provider);
    });

  const auth = program.command("auth").description("manage encrypted API keys (AES-256-GCM)");
  auth
    .command("set <name>")
    .description(
      "store an API key (encrypted); name is the provider id " +
        "(openai | anthropic | gemini | xai | deepseek | groq | openrouter | mistral); " +
        "value from --value or stdin",
    )
    .option("--value <secret>", "the secret value (otherwise read from stdin)")
    .action(async (name: string, opts: { value?: string }) => {
      await authSet(name, opts.value);
    });
  auth.command("list").description("list stored key names").action(authList);
  auth.command("remove <name>").description("delete a stored key").action(authRemove);

  const permissions = program
    .command("permissions")
    .description("inspect the permission policy without running anything");
  permissions
    .command("list", { isDefault: true })
    .description("show every tool's effective permission and what the policy resolves to")
    .option("--mode <mode>", "evaluate under ask | auto | plan | yolo (default: your config)")
    .option("--only <outcome>", "show only allow | deny | prompt rows")
    .option("--builtins-only", "skip MCP/plugin tools (does not start their servers)")
    .option("--json", "emit the table as JSON")
    .action(async (opts, cmd: Command) => {
      await runPermissionsList({
        ...opts,
        json: cmd.optsWithGlobals<{ json?: boolean }>().json,
      });
    });
  permissions
    .command("explain <tool>")
    .description("show what would happen if the agent called <tool>, and why")
    .option("--args <json>", 'tool arguments as JSON, e.g. \'{"command":"rm -rf /"}\'')
    .option("--mode <mode>", "evaluate under ask | auto | plan | yolo (default: your config)")
    .option("--unattended", "evaluate as --autonomous would: nobody is there to answer a prompt")
    .option("--builtins-only", "skip MCP/plugin tools (does not start their servers)")
    .option("--json", "emit the decision trace as JSON")
    .action(async (tool: string, opts, cmd: Command) => {
      await runPermissionsExplain({
        tool,
        ...opts,
        json: cmd.optsWithGlobals<{ json?: boolean }>().json,
      });
    });

  const chronicle = program
    .command("chronicle")
    .description("what this session actually did — a tamper-evident tool ledger");
  chronicle
    .command("verify", { isDefault: true })
    .description("recompute the hash chain (exit 1 if it was edited)")
    .argument("[session]", "session id (default: the most recent)")
    .action((session: string | undefined, _opts, cmd: Command) => {
      runChronicleVerify(session, cmd.optsWithGlobals<{ json?: boolean }>().json ?? false);
    });
  chronicle
    .command("show")
    .description("list the run's tool calls and the files they changed")
    .argument("[session]", "session id (default: the most recent)")
    .action((session: string | undefined, _opts, cmd: Command) => {
      runChronicleShow(session, cmd.optsWithGlobals<{ json?: boolean }>().json ?? false);
    });
  chronicle
    .command("list")
    .description("sessions that have a ledger, newest first")
    .action((_opts, cmd: Command) => {
      runChronicleList(cmd.optsWithGlobals<{ json?: boolean }>().json ?? false);
    });

  program
    .command("tools")
    .description("what the tool roster costs, per tool and per tier")
    .argument("[tier]", "minimal | standard | full (default: show all three)")
    .option("--json", "emit the measurement as JSON")
    .action((tier: string | undefined, opts, cmd: Command) => {
      runToolsCost({
        ...(tier ? { tier } : {}),
        json: opts.json ?? cmd.optsWithGlobals<{ json?: boolean }>().json,
      });
    });

  const memory = program.command("memory").description("view this project's persistent memory");
  memory
    .command("serve", { isDefault: true })
    .description("serve the memory viewer (live local web UI)")
    .option("--port <n>", "port to listen on (default 7777)")
    .option("--open", "open the viewer in your browser")
    .action(async (opts: { port?: string; open?: boolean }) => {
      await memoryServe(opts);
    });
  memory
    .command("ls")
    .description("print this project's memory to the terminal")
    .action(memoryList);

  program
    .command("status")
    .description("check MCP server + plugin health without starting the TUI (exit 1 on failures)")
    .option("--json", "emit machine-readable JSON")
    .action(async (_opts: { json?: boolean }, cmd: Command) => {
      // The root program also declares --json (headless mode) and commander binds
      // the flag there; optsWithGlobals sees it regardless of where it landed.
      await runStatus(cmd.optsWithGlobals<{ json?: boolean }>());
    });

  const mcpCommand = program
    .command("mcp")
    .description("expose this project's memory as a stdio MCP server (like claude-mem)")
    .action(async () => {
      const cwd = process.cwd();
      const config = await loadConfig();
      // stdout is the MCP transport — keep it clean; the server logs to stderr.
      if (config.memory?.engine === "cmem" && config.memory?.mode !== "off") {
        await startCmemMcpServer({ cwd, config });
      } else {
        await startMemoryMcpServer({ cwd });
      }
    });

  mcpCommand
    .command("serve")
    .description("expose Arterm's own tools as a stdio MCP server (read-only unless --writable)")
    .option("--writable", "also publish tools that would normally prompt (never destructive ones)")
    .option("--tier <tier>", "roster to publish from: minimal | standard | full")
    .option("--list", "print what would be published, and why, without starting the server")
    .action(async (opts: { writable?: boolean; tier?: string; list?: boolean }) => {
      await runMcpServe(opts);
    });

  await program.parseAsync(process.argv);
}

// A stray rejection from fire-and-forget background work (an autonomy reflection,
// the on-exit memory digest) must not tear down an active
// session. Registering these handlers also stops Node from terminating the process
// on an unhandled rejection. Output is debug-gated so it never corrupts the Ink TUI.
process.on("unhandledRejection", (reason) => {
  if (process.env.ARTERM_DEBUG) {
    const msg = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
    process.stderr.write(`unhandled rejection: ${msg}\n`);
  }
});
process.on("uncaughtException", (err) => {
  if (process.env.ARTERM_DEBUG) {
    process.stderr.write(`uncaught exception: ${err instanceof Error ? err.stack : String(err)}\n`);
  }
});

main().catch((err) => {
  // Expected, actionable failures print just their message — the CLI shouldn't
  // dump a stack for a bad flag or an unreachable service.
  if (err instanceof ArtermUserError) {
    process.stderr.write(`${err.message}\n`);
  } else if (process.env.ARTERM_DEBUG) {
    process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
  } else {
    // Unexpected: show the message, and point at ARTERM_DEBUG for the full trace.
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.stderr.write("(set ARTERM_DEBUG=1 for the full stack trace)\n");
  }
  process.exit(1);
});
