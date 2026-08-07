import { describe, expect, it } from "vitest";
import { Agent, MAX_IMAGE_BYTES, acceptImages, imagesWithheldNote } from "./agent.js";
import { EventBus } from "./eventBus.js";
import { PermissionManager } from "./permissions.js";
import type { ChatChunk, ChatProvider, ChatRequest, ImageContent, Tool } from "./types.js";

/**
 * The image side channel, from a tool result to the message the provider is
 * handed. Everything here is about one property: an image the model is NOT
 * shown must leave a trace it can read, because the failure being prevented is
 * a model confidently describing a picture it never saw.
 */

/** A 1x1 PNG is irrelevant here — only the base64 alphabet and the size matter. */
function png(bytes = 12): ImageContent {
  return { mediaType: "image/png", data: "A".repeat(bytes) };
}

/** Emits the next scripted turn; records what it was handed. */
class ScriptedProvider implements ChatProvider {
  readonly id = "stub";
  calls = 0;
  lastMessages?: ChatRequest["messages"];
  constructor(private readonly script: ChatChunk[][] = []) {}
  supportsNativeTools(): boolean {
    return true;
  }
  async listModels() {
    return [];
  }
  async *chat(req: ChatRequest): AsyncIterable<ChatChunk> {
    this.lastMessages = req.messages;
    const chunks = this.script[this.calls] ?? [{ type: "text", delta: "done" }];
    this.calls += 1;
    for (const chunk of chunks) yield chunk;
  }
}

describe("acceptImages", () => {
  it("passes a well-formed image through untouched", () => {
    const image = png();
    const { kept, note } = acceptImages([image]);
    expect(kept).toEqual([image]);
    expect(note).toBe("");
  });

  it("is a no-op for a tool that returned none", () => {
    expect(acceptImages(undefined)).toEqual({ kept: [], note: "" });
    expect(acceptImages([])).toEqual({ kept: [], note: "" });
  });

  it("refuses a media type no vision model reads, and says which", () => {
    const { kept, note } = acceptImages([{ mediaType: "image/svg+xml", data: "abc" }]);
    expect(kept).toEqual([]);
    expect(note).toContain("image/svg+xml");
    expect(note).toContain("not an image format");
  });

  it("refuses a data: URI rather than forwarding it as base64", () => {
    // The exact shape a tool written elsewhere sends, and a guaranteed 400.
    const { kept, note } = acceptImages([
      { mediaType: "image/png", data: "data:image/png;base64,AAAA" },
    ]);
    expect(kept).toEqual([]);
    expect(note).toContain("not plain base64");
  });

  it("refuses base64 carrying newlines", () => {
    const { kept } = acceptImages([{ mediaType: "image/png", data: "AAAA\nBBBB" }]);
    expect(kept).toEqual([]);
  });

  it("refuses an empty payload", () => {
    expect(acceptImages([{ mediaType: "image/png", data: "" }]).kept).toEqual([]);
  });

  it("refuses one image over the byte ceiling, naming its size", () => {
    const { kept, note } = acceptImages([png(MAX_IMAGE_BYTES + 1)]);
    expect(kept).toEqual([]);
    expect(note).toContain(String(MAX_IMAGE_BYTES + 1));
  });

  it("caps the TOTAL across a result, not just each image", () => {
    // Two images each under the cap can still exceed it together, and it is the
    // request and the session file that the sum lands in.
    const half = png(Math.floor(MAX_IMAGE_BYTES * 0.6));
    const { kept, note } = acceptImages([half, half]);
    expect(kept).toHaveLength(1);
    expect(note).toContain("exceeds");
  });

  it("keeps the good images when only some are rejected", () => {
    const good = png();
    const { kept, note } = acceptImages([{ mediaType: "image/tiff", data: "AA" }, good]);
    expect(kept).toEqual([good]);
    expect(note).toContain("1 image(s) not shown");
  });
});

describe("imagesWithheldNote", () => {
  it("is empty when there is nothing to report", () => {
    expect(imagesWithheldNote(undefined)).toBe("");
    expect(imagesWithheldNote([])).toBe("");
  });

  it("names the count and the formats", () => {
    const note = imagesWithheldNote([png(), { mediaType: "image/gif", data: "AA" }]);
    expect(note).toContain("2 image(s)");
    expect(note).toContain("image/png, image/gif");
    expect(note).toContain("cannot see images");
  });

  it("does not repeat a format shared by several images", () => {
    expect(imagesWithheldNote([png(), png()])).toContain("(image/png)");
  });
});

describe("Agent carries tool images into history", () => {
  /** One turn that calls `tool`, then a plain answer. */
  function run(tool: Tool): { agent: Agent; provider: ScriptedProvider } {
    const provider = new ScriptedProvider([
      [{ type: "tool_call", call: { id: "c1", name: tool.name, arguments: {} } }],
    ]);
    const agent = new Agent({
      provider,
      model: "m",
      tools: [tool],
      permissions: new PermissionManager({}, "yolo"),
      ask: async () => "allow",
      bus: new EventBus(),
      cwd: process.cwd(),
    });
    return { agent, provider };
  }

  const shooter = (images: ImageContent[]): Tool => ({
    name: "shoot",
    description: "returns an image",
    permission: "allow",
    parameters: { type: "object", properties: {} },
    async execute() {
      return { output: "captured", images };
    },
  });

  it("attaches a tool's images to the tool message, and hands them to the provider", async () => {
    // The second half is the point: history is what the next request is built
    // from, so an image that reaches history but not the request buys nothing.
    const image = png();
    const { agent, provider } = run(shooter([image]));
    await agent.run("look at this");

    const tool = agent.history.find((m) => m.role === "tool");
    expect(tool?.content).toBe("captured");
    expect(tool?.images).toEqual([image]);
    expect(provider.lastMessages?.find((m) => m.role === "tool")?.images).toEqual([image]);
  });

  it("drops an oversized image but leaves the reason in the text", async () => {
    const { agent } = run(shooter([png(MAX_IMAGE_BYTES + 1)]));
    await agent.run("look at this");

    const tool = agent.history.find((m) => m.role === "tool");
    expect(tool?.images).toBeUndefined();
    expect(tool?.content).toContain("captured");
    expect(tool?.content).toContain("not shown to the model");
  });

  it("leaves a text-only tool result exactly as it was", async () => {
    const plain: Tool = {
      name: "plain",
      description: "text",
      permission: "allow",
      parameters: { type: "object", properties: {} },
      async execute() {
        return { output: "just text" };
      },
    };
    const { agent } = run(plain);
    await agent.run("do it");

    const tool = agent.history.find((m) => m.role === "tool");
    expect(tool?.content).toBe("just text");
    expect(tool?.images).toBeUndefined();
  });
});
