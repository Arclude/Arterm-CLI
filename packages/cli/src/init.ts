import { createInterface } from "node:readline/promises";
import { type ArtermConfig, loadConfig, saveConfig } from "@arterm/core";
import { OllamaProvider, hasCredentials, providerCatalog } from "@arterm/providers";
import { ArtermUserError } from "./errors.js";

/**
 * `arterm init` — interactive first-run setup. Walks provider → model →
 * permission mode, marks what's already usable (reachable local backends,
 * stored keys), and writes ~/.arterm/config.json. Existing values become the
 * defaults, so re-running is a safe way to tweak the basics.
 */

interface Choice {
  id: string;
  label: string;
  note?: string;
}

async function pick(
  rl: ReturnType<typeof createInterface>,
  title: string,
  choices: Choice[],
  defaultId: string,
): Promise<string> {
  process.stdout.write(`\n${title}\n`);
  for (const [i, c] of choices.entries()) {
    const marker = c.id === defaultId ? "●" : " ";
    const note = c.note ? `  (${c.note})` : "";
    process.stdout.write(`  ${marker} ${i + 1}. ${c.label}${note}\n`);
  }
  const fallbackNum = Math.max(1, choices.findIndex((c) => c.id === defaultId) + 1);
  const answer = (await rl.question(`Choice [${fallbackNum}]: `)).trim();
  if (!answer) return defaultId;
  const byNumber = choices[Number(answer) - 1];
  if (byNumber) return byNumber.id;
  const byId = choices.find((c) => c.id === answer.toLowerCase());
  if (byId) return byId.id;
  process.stdout.write(`  (unrecognized "${answer}" — keeping ${defaultId})\n`);
  return defaultId;
}

export async function runInit(): Promise<void> {
  if (!process.stdin.isTTY) {
    throw new ArtermUserError("arterm init is interactive — run it in a terminal.");
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const config = await loadConfig();
    process.stdout.write("Arterm setup — Enter keeps the current value (●).\n");

    // Probe the local backend so the picker can say what will work right away.
    const ollama = new OllamaProvider({ host: config.ollamaHost });
    const ollamaUp = await ollama.isReachable();

    const providerChoices: Choice[] = providerCatalog.map((p) => ({
      id: p.id,
      label: p.label,
      note:
        p.id === "ollama"
          ? ollamaUp
            ? "detected"
            : "not running"
          : p.needsKey && hasCredentials(p.id)
            ? "key stored"
            : p.needsKey
              ? "needs API key"
              : undefined,
    }));
    const provider = await pick(rl, "Provider:", providerChoices, config.provider);

    // Model: list what the chosen backend actually has when we can.
    let model = config.model;
    if (provider === "ollama" && ollamaUp) {
      const models = await ollama.listModels().catch(() => []);
      if (models.length > 0) {
        model = await pick(
          rl,
          "Model:",
          models.map((m) => ({
            id: m.name,
            label: m.name,
            note: m.supportsTools ? "tools" : undefined,
          })),
          models.some((m) => m.name === config.model) ? config.model : (models[0]?.name ?? model),
        );
      }
    } else {
      const answer = (await rl.question(`\nModel [${model}]: `)).trim();
      if (answer) model = answer;
    }

    const mode = await pick(
      rl,
      "Permission mode:",
      [
        { id: "ask", label: "ask", note: "prompt before every mutating tool" },
        { id: "auto", label: "auto", note: "auto-approve edits; still ask for commands" },
        { id: "plan", label: "plan", note: "read-only exploration" },
        { id: "yolo", label: "yolo", note: "approve everything (still blocks critical)" },
      ],
      config.mode,
    );

    const next: ArtermConfig = {
      ...config,
      provider,
      model,
      mode: mode as ArtermConfig["mode"],
    };
    await saveConfig(next);

    process.stdout.write(`\nSaved. ${provider}/${model} · mode ${mode}\n`);
    const descriptor = providerCatalog.find((p) => p.id === provider);
    if (descriptor?.needsKey && !hasCredentials(provider)) {
      const oauthHint = descriptor.supportsOAuth ? "  (or: arterm login)" : "";
      process.stdout.write(`This provider needs a key: arterm auth set ${provider}${oauthHint}\n`);
    }
    if (provider === "ollama" && !ollamaUp) {
      process.stdout.write("Ollama isn't running — start it with: ollama serve\n");
    }
    process.stdout.write("Start chatting with: arterm\n");
  } finally {
    rl.close();
  }
}
