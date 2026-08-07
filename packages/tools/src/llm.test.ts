import { describe, expect, it, vi } from "vitest";
import { type LlmRequest, createLlmTool } from "./llm.js";

/** Records what the tool asked for and answers with a canned reply. */
function fakeCall(reply: string) {
  const seen: LlmRequest[] = [];
  const call = async (req: LlmRequest): Promise<string> => {
    seen.push(req);
    return reply;
  };
  return { call, seen };
}

describe("createLlmTool", () => {
  it("is an allow/read tool that neither mutates nor requires a prompt to be dangerous", () => {
    const tool = createLlmTool(async () => "");
    expect(tool.name).toBe("llm");
    expect(tool.permission).toBe("allow");
    expect(tool.category).toBe("read");
    expect(tool.mutating).toBe(false);
    expect(tool.riskTier).toBe("safe");
    expect((tool.parameters as { required: string[] }).required).toEqual(["prompt"]);
    expect(tool.maxOutputBytes).toBeGreaterThan(0);
  });

  it("sends only the system prompt and the prompt — no history", async () => {
    const { call, seen } = fakeCall("  positive  ");
    const tool = createLlmTool(call);
    const res = await tool.execute(
      { prompt: "classify: it works", system: "You label sentiment." },
      { cwd: "." },
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({ prompt: "classify: it works", system: "You label sentiment." });
    expect(res.output).toBe("positive");
    expect(res.isError).toBeFalsy();
  });

  it("passes a model override and the abort signal through", async () => {
    const { call, seen } = fakeCall("ok");
    const tool = createLlmTool(call);
    const signal = new AbortController().signal;
    await tool.execute({ prompt: "q", model: "haiku" }, { cwd: ".", signal });
    expect(seen[0]?.model).toBe("haiku");
    expect(seen[0]?.signal).toBe(signal);
  });

  it("reports a failed call and names the model override rather than retrying without it", async () => {
    const call = vi.fn(async () => {
      throw new Error("model 'haiku' not found");
    });
    const tool = createLlmTool(call);
    const res = await tool.execute({ prompt: "q", model: "haiku" }, { cwd: "." });
    expect(res.isError).toBe(true);
    expect(res.output).toContain("haiku");
    expect(res.output).toContain("not found");
    // One attempt only: a silent fallback would spend the expensive model on a
    // call that explicitly asked for a cheap one.
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("treats an empty answer as a failure", async () => {
    const tool = createLlmTool(async () => "   \n ");
    const res = await tool.execute({ prompt: "q", model: "tiny" }, { cwd: "." });
    expect(res.isError).toBe(true);
    expect(res.output).toContain("no text");
    expect(res.output).toContain("tiny");
  });

  it("errors without calling the model when the prompt is missing", async () => {
    const call = vi.fn(async () => "unused");
    const res = await createLlmTool(call).execute({}, { cwd: "." });
    expect(res.isError).toBe(true);
    expect(call).not.toHaveBeenCalled();
  });

  describe("structured output", () => {
    const schema = {
      type: "object",
      properties: { label: { type: "string" }, score: { type: "number" } },
      required: ["label", "score"],
    };

    it("states the schema in the prompt as well as on the request, and unfences the reply", async () => {
      const { call, seen } = fakeCall('```json\n{"label":"bug","score":3}\n```');
      const res = await createLlmTool(call).execute({ prompt: "grade it", schema }, { cwd: "." });
      expect(seen[0]?.schema).toEqual(schema);
      // Providers without native structured output only ever see the text.
      expect(seen[0]?.prompt).toContain("grade it");
      expect(seen[0]?.prompt).toContain('"required":["label","score"]');
      expect(res.isError).toBeFalsy();
      expect(JSON.parse(res.output)).toEqual({ label: "bug", score: 3 });
    });

    it("keeps the text but flags it when the model ignored the schema", async () => {
      const tool = createLlmTool(async () => "It is probably a bug, I'd say a 3.");
      const res = await tool.execute({ prompt: "grade it", schema }, { cwd: "." });
      expect(res.isError).toBe(true);
      expect(res.output).toContain("did not return valid JSON");
      expect(res.output).toContain("probably a bug");
    });

    it("names the fields a valid JSON reply left out, and still returns it", async () => {
      const tool = createLlmTool(async () => '{"label":"bug"}');
      const res = await tool.execute({ prompt: "grade it", schema }, { cwd: "." });
      expect(res.isError).toBe(true);
      expect(res.output).toContain("score");
      expect(res.output).not.toContain("label,");
      expect(res.output).toContain('"label": "bug"');
    });

    it("accepts a schema handed over as a JSON string", async () => {
      const { call, seen } = fakeCall('{"label":"x","score":1}');
      const res = await createLlmTool(call).execute(
        { prompt: "grade it", schema: JSON.stringify(schema) },
        { cwd: "." },
      );
      expect(seen[0]?.schema).toEqual(schema);
      expect(res.isError).toBeFalsy();
    });

    it("refuses a schema that is neither an object nor JSON, without calling the model", async () => {
      const call = vi.fn(async () => "unused");
      const res = await createLlmTool(call).execute(
        { prompt: "grade it", schema: "not json" },
        { cwd: "." },
      );
      expect(res.isError).toBe(true);
      expect(res.output).toContain("JSON Schema object");
      expect(call).not.toHaveBeenCalled();
    });

    it("passes a non-object schema's reply straight through when nothing is required", async () => {
      const tool = createLlmTool(async () => "[1, 2, 3]");
      const res = await tool.execute(
        { prompt: "list them", schema: { type: "array" } },
        { cwd: "." },
      );
      expect(res.isError).toBeFalsy();
      expect(JSON.parse(res.output)).toEqual([1, 2, 3]);
    });
  });
});
