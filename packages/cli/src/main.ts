import { SessionLog, loadConfig } from "@arterm/core";
import { OllamaProvider, allProviders } from "@arterm/providers";
import { runTui } from "@arterm/tui";
import { Command } from "commander";
import { buildSession } from "./session.js";

const VERSION = "0.1.0";

interface GlobalOpts {
  provider?: string;
  model?: string;
  yolo?: boolean;
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

  // Record this session up front so even an empty conversation is logged.
  const log = await SessionLog.create({ model: config.model, provider: providerId });

  await runTui(session);

  // Persist the full conversation after the TUI exits — agent.history holds the
  // complete user/assistant/tool transcript, which is simpler and more reliable
  // than reconstructing it from individual bus events.
  for (const message of session.agent.history) {
    await log.logMessage(message);
  }

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
    .option("--yolo", "skip all permission prompts");

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
