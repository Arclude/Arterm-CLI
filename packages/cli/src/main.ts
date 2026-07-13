import { join } from "node:path";
import {
  ARTERM_HOME,
  type ArtermConfig,
  type CatalogModel,
  type EventBus,
  Keystore,
  type Message,
  type SessionStore,
  type SessionSummary,
  createSessionStore,
  fetchCatalog,
  findModelById,
  loadConfig,
  projectKey,
  readProjectRecords,
  registerAgentDefinitions,
  retentionFromConfig,
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
  startMemoryMcpServer,
} from "@arterm/tools";
import type { Session } from "@arterm/tui";
import { Command } from "commander";
import { openBrowser } from "./browser.js";
import { ArtermUserError } from "./errors.js";
import { runHeadless } from "./headless.js";
import { runInit } from "./init.js";
import { formatRecordsText, startCmemServer, startMemoryServer } from "./memoryServer.js";
import { buildSession } from "./session.js";
import { runStatus } from "./status.js";
import { type StatusServer, startStatusServer } from "./statusServer.js";
import { isKnownProvider, parsePort, unknownProviderMessage } from "./validate.js";

const VERSION = "0.3.3";

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
): Promise<Message[] | undefined> {
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
  return messages;
}

interface GlobalOpts {
  provider?: string;
  model?: string;
  yolo?: boolean;
  confirmDestructive?: boolean;
  goal?: string;
  /** One-shot prompt; runs headlessly (no TUI) and prints the result. */
  print?: string;
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
}

/**
 * Start the desktop status server when enabled (docs/desktop-integration.md).
 * Precedence: --no-status-server > --status-port (implies on) > config.statusServer
 * ("auto" = only when ARTERM_TERMINAL is set). Failure warns and never blocks startup.
 */
async function maybeStartStatusServer(
  session: Session,
  config: ArtermConfig,
  globals: GlobalOpts,
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
  const enabled = config.statusServer?.enabled ?? "auto";
  const on =
    pinned !== undefined ||
    enabled === true ||
    (enabled === "auto" && Boolean(process.env.ARTERM_TERMINAL));
  if (!on) return undefined;
  try {
    return await startStatusServer({
      session,
      cwd: process.cwd(),
      port: pinned ?? config.statusServer?.port ?? 0,
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

async function startChat(globals: GlobalOpts): Promise<void> {
  const config = await loadConfig();
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
  const initialMessages = await resolveResumeMessages(store, globals);

  const { session, persist, digest } = await buildSession({
    config,
    providerId: globals.provider,
    model: globals.model,
    yolo: globals.yolo,
    confirmDestructive: globals.confirmDestructive,
    cwd: process.cwd(),
    initialMessages,
  });

  // Trim old transcripts (best-effort), then open this session's store handle.
  try {
    await store.prune(retentionFromConfig(config));
  } catch (err) {
    // Pruning must never block startup; surface it only under ARTERM_DEBUG.
    if (process.env.ARTERM_DEBUG) {
      process.stderr.write(`⚠ session prune failed: ${(err as Error).message}\n`);
    }
  }
  const handle = await store.create({ model: config.model, provider: providerId });

  // Log messages incrementally as they're produced, so in-memory context
  // compaction never loses the on-disk record.
  session.agent.setOnMessage((message) => handle.logMessage(message));

  // Load external capabilities: MCP servers, local plugins, and skills.
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
  session.agentDefs = agentDefs.summary;

  // Fold external tools into the agent (built-ins win on name collisions).
  const existing = new Set(session.agent.tools.map((t) => t.name));
  const extra = [...mcpTools, ...pluginTools].filter((t) => !existing.has(t.name));
  if (extra.length > 0) {
    session.agent.setTools([...session.agent.tools, ...extra]);
    session.toolCount = session.agent.tools.length;
  }
  session.agent.setSkills(skills.list());
  session.mcpServers = mcp.summary;
  session.plugins = plugins.summary;
  session.skills = skills.list();
  session.getSkillBody = (name) => skills.get(name)?.body;

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

  // Remote-host reachability check runs off the critical path (see the helper) —
  // by now the session bus exists, so a failure can surface inside the TUI.
  probeCompatHostInBackground(providerId, config, session.bus);

  const statusServer = await maybeStartStatusServer(session, config, globals);

  // Lazy: ink (and its yoga-layout WASM) costs ~800ms to import — load it only
  // when the TUI is actually about to render, keeping --version/--print fast.
  const { runTui } = await import("@arterm/tui");
  await runTui(session, { goal: globals.goal });

  await statusServer?.close();
  await mcp.close();
  // Digest this session's activity into persistent memory before exiting.
  try {
    await digest();
  } catch (err) {
    // Memory digest must never block a clean shutdown; show it under ARTERM_DEBUG.
    if (process.env.ARTERM_DEBUG) {
      process.stderr.write(`⚠ memory digest failed: ${(err as Error).message}\n`);
    }
  }
  await persist();
}

/**
 * One-shot, non-interactive run for scripting/CI: take a prompt from --print or
 * piped stdin, run it to completion without the TUI, print the result, and exit.
 * Unlike `startChat` this skips the preflight banner (it would dirty stdout, and
 * --json output especially) and external capability loading (MCP/plugins/skills)
 * to stay fast and predictable — built-in tools + memory still apply.
 */
async function runHeadlessFlow(globals: GlobalOpts): Promise<void> {
  const prompt = globals.print ?? (await readStdin());
  const config = await loadConfig();
  const providerId = globals.provider ?? config.provider;
  requireKnownProvider(providerId);

  const store = createSessionStore(config);
  const initialMessages = await resolveResumeMessages(store, globals);

  const { session, persist, digest } = await buildSession({
    config,
    providerId: globals.provider,
    model: globals.model,
    yolo: globals.yolo,
    confirmDestructive: globals.confirmDestructive,
    cwd: process.cwd(),
    initialMessages,
  });

  // Record this turn so it's resumable later (no-op when session.mode is "off").
  const handle = await store.create({ model: config.model, provider: providerId });
  session.agent.setOnMessage((message) => handle.logMessage(message));

  const statusServer = await maybeStartStatusServer(session, config, globals);

  try {
    await runHeadless(session, prompt, { json: globals.json });
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
    .option("--goal <text>", "start an autonomous run toward this goal")
    .option("--print <prompt>", "run a single prompt headlessly (no TUI) and print the result")
    .option("--json", "with --print or piped input, emit the result as JSON")
    .option("--resume <id>", "resume a recorded session by id (see `arterm sessions`)")
    .option("--continue", "resume the most recent recorded session")
    .option("--status-port <port>", "pin the desktop status server port (implies enabled)")
    .option("--no-status-server", "disable the desktop status server");

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

  program
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
