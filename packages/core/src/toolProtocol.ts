import { randomUUID } from "node:crypto";
import type { ToolCall, ToolSchema } from "./types.js";

/**
 * Tool-calling for models that lack a native function-calling API.
 *
 * We describe the tools in the system prompt and ask the model to emit a fenced
 * ```json block of the shape {"tool": "<name>", "args": { ... }}. After each turn
 * we scan the assistant text for such blocks and turn them into ToolCalls.
 */

export function toolSystemPrompt(tools: ToolSchema[]): string {
  const lines = tools.map(
    (t) => `- ${t.name}: ${t.description}\n  parameters: ${JSON.stringify(t.parameters)}`,
  );
  return [
    "You can call tools to inspect and modify the project.",
    "When you want to call a tool, respond with ONLY a fenced json block:",
    "```json",
    '{"tool": "<tool_name>", "args": { ... }}',
    "```",
    "Call one tool at a time and wait for its result before continuing.",
    "When you are done and need no tool, reply normally with no json block.",
    "",
    "Available tools:",
    ...lines,
  ].join("\n");
}

interface RawCall {
  tool?: unknown;
  args?: unknown;
}

function asCall(value: RawCall): ToolCall | null {
  if (typeof value.tool !== "string") return null;
  const args =
    value.args && typeof value.args === "object" ? (value.args as Record<string, unknown>) : {};
  return { id: randomUUID(), name: value.tool, arguments: args };
}

/**
 * Scans `text` for top-level balanced `{...}` JSON objects, respecting string
 * literals and escapes so braces inside strings don't throw off the matching.
 * Used to recover bare (unfenced) tool calls.
 */
function extractBalancedObjects(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}" && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) {
        out.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return out;
}

/**
 * Extracts tool calls from assistant text and returns the text with those blocks
 * stripped. Tolerates ```json fences, plain ``` fences, and arrays of calls.
 * Falls back to bare (unfenced) JSON objects — common with small local models —
 * which also rescues calls whose file content embeds its own ``` fences.
 */
export function parseToolCalls(text: string): { calls: ToolCall[]; cleaned: string } {
  const calls: ToolCall[] = [];
  let cleaned = text;

  const consume = (body: string, fullMatch: string): void => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.trim());
    } catch {
      return;
    }
    const candidates = Array.isArray(parsed) ? parsed : [parsed];
    let consumed = false;
    for (const c of candidates) {
      if (c && typeof c === "object" && "tool" in c) {
        const call = asCall(c as RawCall);
        if (call) {
          calls.push(call);
          consumed = true;
        }
      }
    }
    if (consumed) cleaned = cleaned.replace(fullMatch, "");
  };

  // 1) Preferred: fenced ```json blocks.
  const fence = /```(?:json)?\s*([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex exec loop
  while ((match = fence.exec(text)) !== null) {
    const body = match[1];
    if (body?.trim()) consume(body, match[0]);
  }

  // 2) Fallback: bare JSON objects (no fence, or fences broken by nested ```).
  if (calls.length === 0) {
    for (const obj of extractBalancedObjects(text)) {
      if (obj.includes('"tool"')) consume(obj, obj);
    }
  }

  return { calls, cleaned: cleaned.trim() };
}
