import { join } from "node:path";
import {
  ARTERM_HOME,
  Keystore,
  createSessionStore,
  loadConfig,
  retentionFromConfig,
} from "@arterm/core";
import { McpManager, PluginLoader, SkillRegistry } from "@arterm/tools";
import { OllamaProvider, allProviders } from "@arterm/providers";
import { runTui } from "@arterm/tui";
import { Command } from "commander";
import { buildSession } from "./session.js";

const VERSION = "0.1.0";

interface GlobalOpts {
  provider?: string;
  model?: string;
  yolo?: boolean;
  goal?: string;
}

async function startChat(globals: GlobalOpts): Promise<void> {
  const config = await loadConfig();
  const providerId = globals.provider ?? config.provider;

  if (providerId === "ollama") {
    const ok = await new OllamaProvider({ host: config.ollamaHost }).isReachable();
    if (!ok) {
      process.stdout.write(
        `⚠ Ollama not reachable at ${config.ollamaHost}. Start it with \`ollama serve\`, or switch provider with --provider llamacpp.\n`,
      );
    }
  }

  const { session, persist } = buildSession({
    config,
    providerId: globals.provider,
    model: globals.model,
    yolo: globals.yolo,
    cwd: process.cwd(),
  });

  // Trim old transcripts (best-effort), then open this session's store handle.
  // With session.mode "off" (the default) this is a no-op and nothing hits disk.
  const store = createSessionStore(config);
  try {
    await store.prune(retentionFromConfig(config));
  } catch {
    // Pruning must never block startup.
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

  const [mcpTools, pluginTools] = await Promise.all([mcp.connect(), plugins.load()]);
  await skills.load();

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

  await runTui(session, { goal: globals.goal });

  await mcp.close();
  await persist();
}

async function listModels(): Promise<void> {
  const config = await loadConfig();
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
      const tools = m.supportsTools ? " [tools]" : "";
      process.stdout.write(`  ${m.name}${tools}\n`);
    }
  }
}

async function pullModel(model: string): Promise<void> {
  const config = await loadConfig();
  const provider = new OllamaProvider({ host: config.ollamaHost });
  process.stdout.write(`Pulling ${model} …\n`);
  let last = "";
  for await (const status of provider.pull(model)) {
    if (status !== last) {
      process.stdout.write(`  ${status}\n`);
      last = status;
    }
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

async function main(): Promise<void> {
  const program = new Command();
  program
    .name("arterm")
    .description("Local AI coding agent for your terminal")
    .version(VERSION)
    .option("-p, --provider <id>", "provider: ollama | llamacpp")
    .option("-m, --model <name>", "model name or .gguf file")
    .option("--yolo", "skip all permission prompts")
    .option("--goal <text>", "start an autonomous run toward this goal");

  program
    .command("chat", { isDefault: true })
    .description("start an interactive chat session (default)")
    .action(async () => {
      await startChat(program.opts());
    });

  program
    .command("models")
    .description("list available models across providers")
    .action(listModels);

  program.command("pull <model>").description("download a model via Ollama").action(pullModel);

  const auth = program.command("auth").description("manage encrypted API keys (AES-256-GCM)");
  auth
    .command("set <name>")
    .description("store an API key (encrypted); value from --value or stdin")
    .option("--value <secret>", "the secret value (otherwise read from stdin)")
    .action(async (name: string, opts: { value?: string }) => {
      await authSet(name, opts.value);
    });
  auth.command("list").description("list stored key names").action(authList);
  auth.command("remove <name>").description("delete a stored key").action(authRemove);

  await program.parseAsync(process.argv);
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
