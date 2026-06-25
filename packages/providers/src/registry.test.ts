import type { ArtermConfig } from "@arterm/core";
import { describe, expect, it } from "vitest";
import { createProvider, hasApiKey, hostedProviderIds } from "./registry.js";

const config = {
  provider: "ollama",
  model: "llama3.2",
  ollamaHost: "http://127.0.0.1:11434",
  openaiCompatHost: "http://localhost:1234/v1",
  modelsDir: "/tmp/models",
} as ArtermConfig;

describe("createProvider", () => {
  it("builds each hosted OpenAI-compatible preset under its own id", () => {
    for (const id of hostedProviderIds) {
      expect(createProvider(config, id).id).toBe(id);
    }
  });

  it("exposes the expected hosted vendors", () => {
    expect(hostedProviderIds).toEqual(
      expect.arrayContaining([
        "openai",
        "gemini",
        "xai",
        "deepseek",
        "groq",
        "openrouter",
        "mistral",
      ]),
    );
  });

  it("still builds the local and native providers", () => {
    expect(createProvider(config, "ollama").id).toBe("ollama");
    expect(createProvider(config, "llamacpp").id).toBe("llamacpp");
    expect(createProvider(config, "openai-compat").id).toBe("openai-compat");
    expect(createProvider(config, "anthropic").id).toBe("anthropic");
  });

  it("throws on an unknown provider id", () => {
    expect(() => createProvider(config, "nope")).toThrow(/Unknown provider/);
  });
});

describe("hasApiKey", () => {
  it("is false for local providers and unknown ids", () => {
    expect(hasApiKey("ollama")).toBe(false);
    expect(hasApiKey("llamacpp")).toBe(false);
    expect(hasApiKey("openai-compat")).toBe(false);
    expect(hasApiKey("nope")).toBe(false);
  });

  it("is true for a hosted provider once its env key is set", () => {
    const prev = process.env.GROQ_API_KEY;
    try {
      process.env.GROQ_API_KEY = "test-key";
      expect(hasApiKey("groq")).toBe(true);
    } finally {
      if (prev === undefined) {
        // biome-ignore lint/performance/noDelete: env must be truly removed; `= undefined` stringifies.
        delete process.env.GROQ_API_KEY;
      } else {
        process.env.GROQ_API_KEY = prev;
      }
    }
  });
});
