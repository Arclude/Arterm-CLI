import type { ChatChunk } from "@arterm/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OllamaProvider } from "./ollama.js";

function ndjsonResponse(lines: object[]): Response {
  const body = lines.map((l) => JSON.stringify(l)).join("\n");
  return new Response(body, { status: 200 });
}

describe("OllamaProvider.supportsNativeTools", () => {
  const p = new OllamaProvider({ host: "http://localhost:11434" });

  it("recognizes tool-capable families including bare family names", () => {
    for (const m of [
      "llama3:8b",
      "llama3.1",
      "llama4",
      "qwen2",
      "qwen2.5-coder",
      "qwen3",
      "granite3-dense",
      "nemotron",
      "command-r",
      "mistral-nemo",
      "mixtral",
      "qwq",
    ]) {
      expect(p.supportsNativeTools(m)).toBe(true);
    }
  });

  it("returns false for models without native tool support", () => {
    expect(p.supportsNativeTools("gemma2")).toBe(false);
    expect(p.supportsNativeTools("phi3")).toBe(false);
  });
});

describe("OllamaProvider.chat tool-call normalization", () => {
  afterEach(() => vi.restoreAllMocks());

  it("parses tool-call arguments delivered as a JSON string", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      ndjsonResponse([
        {
          message: { tool_calls: [{ function: { name: "do_it", arguments: '{"x":1,"y":"a"}' } }] },
        },
        { done: true, prompt_eval_count: 1, eval_count: 2 },
      ]),
    );
    const p = new OllamaProvider({ host: "http://localhost:11434" });
    const chunks: ChatChunk[] = [];
    for await (const c of p.chat({ model: "llama3", messages: [] })) chunks.push(c);

    const call = chunks.find((c) => c.type === "tool_call");
    expect(call?.type).toBe("tool_call");
    if (call?.type === "tool_call") {
      expect(call.call.name).toBe("do_it");
      expect(call.call.arguments).toEqual({ x: 1, y: "a" });
    }
  });
});
