import { createSessionStore, loadConfig, retentionFromConfig } from "@arterm/core";
import { McpManager } from "@arterm/tools";
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

  // Connect configured MCP servers and fold their tools into the agent.
  const mcp = new McpManager(config.mcpServers);
  const mcpTools = await mcp.connect();
  if (mcpTools.length > 0) {
    session.agent.setTools([...session.agent.tools, ...mcpTools]);
    session.toolCount = session.agent.tools.length;
  }
  session.mcpServers = mcp.summary;
  for (const s of mcp.summary) {
    if (s.status === "failed") {
      process.stdout.write(`⚠ MCP server "${s.name}" failed to connect: ${s.error}\n`);
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

  await program.parseAsync(process.argv);
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
