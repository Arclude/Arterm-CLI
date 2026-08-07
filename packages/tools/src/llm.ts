/**
 * The `llm` tool: one model call the MODEL can make for itself.
 *
 * The session has always been able to do this internally — `summarizeWith()` in
 * `buildSession` is a tool-free one-shot, and `roll_up` already delegates to it.
 * What was missing is the model's own access to it, so every cheap mechanical
 * question (classify this line, pull four fields out of this blob, condense this
 * log) had only two answers: do it in the main context, paying for the raw
 * material in every later turn and every compaction, or `spawn` a whole
 * sub-agent with a tool roster and a loop to run a question that needs neither.
 *
 * Two things the injector owes this tool, neither of which it can check itself:
 *
 * NO HISTORY. `Agent.plan()` looks like the same one-shot but prepends the
 * leader's ENTIRE conversation, which is exactly the cost this exists to avoid —
 * the same trap `roll_up`'s summariser is documented as sidestepping. The call
 * must see the system prompt and the prompt, and nothing else.
 *
 * METER THE SPEND. `budgetMeter` is a `response` PIPELINE stage inside the agent
 * loop, so a bare `provider.chat` made outside the loop is invisible to
 * `--budget` and to the usage the headless run reports. Cost is the control this
 * tool is governed by (see the permission comment), so the closure that makes
 * the call is where it has to be charged.
 */
import type { Tool } from "@arterm/core";
import { optionalString, requireString } from "./paths.js";

/** One model call's whole world: no history, no tools, nothing but these fields. */
export interface LlmRequest {
  /** The question and its material. Everything the call knows must be in here. */
  prompt: string;
  /** The system prompt for this call alone — not the session's. */
  system?: string;
  /**
   * A different (typically cheaper) model. It names a model on the provider the
   * session is ALREADY using, never a provider selector: that is what keeps this
   * from being an egress channel, since the destination stays the one the main
   * loop hands the whole conversation to every turn anyway.
   */
  model?: string;
  /** JSON Schema the reply should match, when the caller asked for structure. */
  schema?: Record<string, unknown>;
  signal?: AbortSignal;
}

/**
 * Runs one model call and resolves its raw text. Injected exactly like
 * `SpawnFn`/`RollUpFn` so `@arterm/tools` never learns what a provider is.
 */
export type LlmCallFn = (req: LlmRequest) => Promise<string>;

/**
 * A delegated answer is meant to be SMALL — a label, a few fields, a paragraph.
 * Past this the central clamp keeps both ends, cuts the middle and spools the
 * rest to a file it names; that is also the signal that the question wanted a
 * sub-agent which can read and iterate, not a one-shot that cannot.
 */
const MAX_OUTPUT = 32_768;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Accept the schema as an object or as a JSON string. Small models routinely
 * stringify a nested argument, and refusing that costs a whole round trip to
 * re-send the same schema in a different wrapper.
 */
function readSchema(value: unknown): { schema?: Record<string, unknown>; error?: string } {
  if (value === undefined || value === null) return {};
  if (isObject(value)) return { schema: value };
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      if (isObject(parsed)) return { schema: parsed };
    } catch {
      // Fall through to the shared message below.
    }
  }
  return { error: "schema must be a JSON Schema object (or a JSON string holding one)" };
}

/** Strip a ```json … ``` fence — the wrapper models add most often around JSON. */
function unfence(text: string): string {
  const fenced = /^\s*```(?:json|jsonc)?\s*\r?\n([\s\S]*?)\r?\n?\s*```\s*$/i.exec(text);
  return fenced?.[1] ?? text;
}

/**
 * Top-level required keys the schema names but the reply omitted.
 *
 * A full JSON Schema validator is deliberately not the job here — it is a
 * dependency, and the two failures that actually happen are "answered in prose"
 * and "dropped a field", both of which this catches. Reporting a missing field
 * at the call is the whole point: unreported, it surfaces as an `undefined` two
 * steps later, where nothing connects it back to the model that skipped it.
 */
function missingKeys(schema: Record<string, unknown>, value: unknown): string[] {
  if (schema.type !== "object" || !Array.isArray(schema.required)) return [];
  if (!isObject(value)) return [];
  return schema.required.filter((key): key is string => typeof key === "string" && !(key in value));
}

/**
 * The schema is stated IN the prompt as well as passed on the request. Whether a
 * provider has native structured output is a capability this package cannot see,
 * and much of what Arterm runs is a local model over Ollama that has none — so
 * the only instruction every model reliably receives is the one in the text. The
 * request field is set too, so a session wired to a provider that honours it
 * gets both, and the parse below has to hold either way.
 */
function schemaInstruction(schema: Record<string, unknown>): string {
  return `Reply with JSON only — no prose, no code fence — matching this JSON Schema:\n${JSON.stringify(schema)}`;
}

/**
 * Builds the `llm` tool. The call itself is injected (the session wires it over
 * its live provider binding), so this file stays decoupled from how a model is
 * reached and a test can drive the whole tool with a fake.
 */
export function createLlmTool(call: LlmCallFn): Tool {
  return {
    name: "llm",
    maxOutputBytes: MAX_OUTPUT,
    description:
      "Ask a separate, fresh model instance ONE self-contained question and get its answer back. " +
      "It has no tools and no memory of this conversation — it sees only `system` and `prompt`, " +
      "so everything it needs must be in them. Use it for cheap mechanical work (classify, " +
      "extract fields, summarise a blob) so the raw material never enters this context.",
    usageHint:
      "Paste the material INTO `prompt` — it cannot read your files or your history, and a " +
      "question that refers to 'the file above' gets a confident answer about nothing. Give " +
      "`schema` whenever you will act on the answer programmatically: a schema turns 'probably " +
      "the second one' into a field you can branch on. Use `model` for a cheaper model on this " +
      "same provider when the task is mechanical; leave it off when the answer needs judgement.",
    selection: {
      doNotUseWhen: "the work needs to read files, run commands, or take more than one step",
      useInstead: "spawn",
    },
    // A one-shot with NO tools: it cannot read a file, write one, or run a
    // command — the whole difference from `spawn`, which is "ask"/"execute"/
    // mutating because a sub-agent can do all three. What it does do is spend
    // money and reach the network, but only the provider this session is already
    // talking to, with the session's own credentials, and the main loop hands
    // that same endpoint the entire conversation every turn. So it adds no
    // destination and no secret the surrounding turn did not already involve —
    // unlike `web_fetch`/`web_search`, which are "ask" precisely because they
    // reach hosts of the model's choosing.
    //
    // That leaves cost, and a prompt is the wrong control for cost: this tool
    // exists to be cheaper than answering in the main context, and a
    // confirmation per call makes it dearer than the thing it replaces — the
    // `todo.ts` argument, where a gate priced the model out of the habit the
    // tool was built to create. The ceiling for spend is the run budget, which
    // is why the module header insists the injected call be charged to it.
    //
    // `category: "read"` is load-bearing rather than a default: plan mode denies
    // every non-read category and a sub-agent's asker answers "deny", so
    // "execute" would remove this tool from exactly the two situations —
    // planning, and delegated work — where a cheap question earns the most
    // (the `submit_verdict` lesson).
    permission: "allow",
    category: "read",
    mutating: false,
    riskTier: "safe",
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description:
            "The question, INCLUDING the material it is about. The call sees nothing else.",
        },
        system: {
          type: "string",
          description:
            "Who the model should be for this call, e.g. 'You are a strict JSON extractor.'",
        },
        schema: {
          type: "object",
          description:
            "JSON Schema the reply must match. Given one, the answer comes back as JSON.",
        },
        model: {
          type: "string",
          description: "A cheaper model on this provider. Omitted, the session's model answers.",
        },
      },
      required: ["prompt"],
    },
    preview: (args) => {
      const model = optionalString(args, "model");
      return `llm${model ? ` (${model})` : ""}: ${String(args.prompt ?? "").slice(0, 60)}`;
    },
    async execute(args, ctx) {
      let prompt: string;
      try {
        prompt = requireString(args, "prompt");
      } catch (err) {
        return { output: (err as Error).message, isError: true };
      }
      const { schema, error } = readSchema(args.schema);
      if (error) return { output: error, isError: true };
      const system = optionalString(args, "system")?.trim();
      const model = optionalString(args, "model")?.trim();
      // The schema goes last so it is the final instruction the model reads.
      const body = schema ? `${prompt}\n\n${schemaInstruction(schema)}` : prompt;

      let text: string;
      try {
        text = await call({
          prompt: body,
          ...(system ? { system } : {}),
          ...(model ? { model } : {}),
          ...(schema ? { schema } : {}),
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
      } catch (err) {
        // An invalid `model` override lands here — a name the active provider
        // does not serve — and the call is NOT retried on the session's default.
        // `memorySummarize` in the session does fall back, because a failed
        // digest is silent and the alternative is losing every observation; this
        // failure is not silent, it is a tool result the caller reads and can
        // retry itself. Falling back would spend the expensive model on a call
        // that explicitly asked for a cheap one, and say so only in a line of
        // output nobody diffs.
        const why = model ? ` (model override "${model}" — try again without it)` : "";
        return { output: `llm call failed${why}: ${(err as Error).message}`, isError: true };
      }

      const answer = text.trim();
      if (!answer) {
        // The tool's only product is text, so no text is the whole failure —
        // and an override the provider accepted but does not serve is the most
        // common way to get here, which is why it is named.
        const why = model ? ` (model override "${model}")` : "";
        return { output: `llm returned no text${why}.`, isError: true };
      }
      if (!schema) return { output: answer };

      let parsed: unknown;
      try {
        parsed = JSON.parse(unfence(answer));
      } catch {
        // The model ignored the schema and answered in prose. Both halves of the
        // handling matter: FLAG it, so nothing downstream parses a paragraph as
        // JSON several steps from the cause, and KEEP the text, because it is
        // the only thing the call produced — the same trade `roll_up` makes when
        // it has no summariser and hands back the raw results rather than
        // pretending.
        return {
          output: `llm was asked for JSON matching the schema and did not return valid JSON.\nRaw reply:\n${answer}`,
          isError: true,
        };
      }

      // Re-serialised rather than echoed back: the fence is gone and the shape is
      // canonical, so whatever reads this next can parse it without knowing which
      // wrapper this particular model happens to like.
      const json = JSON.stringify(parsed, null, 2);
      const missing = missingKeys(schema, parsed);
      if (missing.length > 0) {
        return {
          output: `llm returned JSON missing required field(s): ${missing.join(", ")}\n${json}`,
          isError: true,
        };
      }
      return { output: json };
    },
  };
}
