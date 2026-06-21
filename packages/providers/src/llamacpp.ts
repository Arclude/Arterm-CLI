import { promises as fs } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { ChatChunk, ChatProvider, ChatRequest, Message, ModelInfo } from "@arterm/core";

/**
 * Runs a GGUF model directly in-process via node-llama-cpp — no server needed.
 *
 * node-llama-cpp is an optional native dependency, so it is imported lazily; if
 * it is not installed we surface a clear, actionable error instead of crashing
 * at startup. Tool-calling uses the universal JSON fallback (supportsNativeTools
 * is false) to keep the integration simple and model-agnostic.
 */
export interface LlamaCppOptions {
  /** Directory that holds .gguf files. */
  modelsDir: string;
}

// Cached across calls — loading a model is expensive.
let llamaPromise: Promise<any> | null = null;
const modelCache = new Map<string, Promise<any>>();

async function getLlamaModule(): Promise<any> {
  // Indirected specifier so TS/tsup don't try to statically resolve an optional,
  // possibly-uninstalled native module at build time.
  const moduleName = "node-llama-cpp";
  try {
    return await import(moduleName);
  } catch {
    throw new Error(
      "node-llama-cpp is not installed. Run `pnpm add node-llama-cpp` to enable direct GGUF loading, " +
        "or use the Ollama provider instead.",
    );
  }
}

export class LlamaCppProvider implements ChatProvider {
  readonly id = "llamacpp";

  constructor(private opts: LlamaCppOptions) {}

  supportsNativeTools(): boolean {
    return false;
  }

  private resolvePath(model: string): string {
    const file = model.endsWith(".gguf") ? model : `${model}.gguf`;
    return isAbsolute(file) ? file : join(this.opts.modelsDir, file);
  }

  async listModels(): Promise<ModelInfo[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.opts.modelsDir);
    } catch {
      return [];
    }
    const out: ModelInfo[] = [];
    for (const name of entries) {
      if (!name.endsWith(".gguf")) continue;
      const stat = await fs.stat(join(this.opts.modelsDir, name)).catch(() => null);
      out.push({
        name,
        provider: this.id,
        sizeBytes: stat?.size,
        supportsTools: false,
      });
    }
    return out;
  }

  private async loadModel(modelPath: string): Promise<any> {
    const cached = modelCache.get(modelPath);
    if (cached) return cached;
    const promise = (async () => {
      const mod = await getLlamaModule();
      llamaPromise ??= mod.getLlama();
      const llama = await llamaPromise;
      return llama.loadModel({ modelPath });
    })();
    modelCache.set(modelPath, promise);
    return promise;
  }

  async *chat(req: ChatRequest): AsyncIterable<ChatChunk> {
    const mod = await getLlamaModule();
    const model = await this.loadModel(this.resolvePath(req.model));
    const context = await model.createContext();

    try {
      const session = new mod.LlamaChatSession({
        contextSequence: context.getSequence(),
        systemPrompt: systemText(req.messages),
      });
      const history = toLlamaHistory(req.messages);
      if (history.length > 0) session.setChatHistory(history);

      const queue = new ChunkQueue();
      const promptText = lastPromptText(req.messages);

      const done = session
        .prompt(promptText, {
          temperature: req.temperature,
          signal: req.signal,
          onTextChunk: (text: string) => queue.push({ type: "text", delta: text }),
        })
        .then(() => queue.close())
        .catch((err: unknown) => queue.fail(err));

      yield* queue.drain();
      await done;
      yield { type: "done" };
    } finally {
      await context.dispose?.();
    }
  }
}

/** Bridges node-llama-cpp's onTextChunk callback into an async iterable. */
class ChunkQueue {
  private items: ChatChunk[] = [];
  private resolve: (() => void) | null = null;
  private finished = false;
  private error: unknown = null;

  push(chunk: ChatChunk): void {
    this.items.push(chunk);
    this.wake();
  }

  close(): void {
    this.finished = true;
    this.wake();
  }

  fail(err: unknown): void {
    this.error = err;
    this.finished = true;
    this.wake();
  }

  private wake(): void {
    this.resolve?.();
    this.resolve = null;
  }

  async *drain(): AsyncGenerator<ChatChunk> {
    while (true) {
      while (this.items.length > 0) {
        yield this.items.shift() as ChatChunk;
      }
      if (this.error) throw this.error;
      if (this.finished) return;
      await new Promise<void>((r) => {
        this.resolve = r;
      });
    }
  }
}

function systemText(messages: Message[]): string | undefined {
  const parts = messages.filter((m) => m.role === "system").map((m) => m.content);
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

/** Everything except the trailing prompt becomes prior chat history. */
function toLlamaHistory(messages: Message[]): any[] {
  const items: any[] = [];
  const body = messages.slice(0, -1).filter((m) => m.role !== "system");
  for (const m of body) {
    if (m.role === "user") items.push({ type: "user", text: m.content });
    else if (m.role === "assistant") items.push({ type: "model", response: [m.content] });
    else if (m.role === "tool")
      items.push({ type: "user", text: `Tool result (${m.name ?? "tool"}):\n${m.content}` });
  }
  return items;
}

function lastPromptText(messages: Message[]): string {
  const last = messages[messages.length - 1];
  if (!last) return "";
  if (last.role === "tool") return `Tool result (${last.name ?? "tool"}):\n${last.content}`;
  return last.content;
}
