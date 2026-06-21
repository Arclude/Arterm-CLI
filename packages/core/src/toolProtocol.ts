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
 * Extracts tool calls from assistant text and returns the text with those blocks
 * stripped. Tolerates ```json fences, plain ``` fences, and arrays of calls.
 */
export function parseToolCalls(text: string): { calls: ToolCall[]; cleaned: string } {
  const calls: ToolCall[] = [];
  const fence = /```(?:json)?\s*([\s\S]*?)```/g;
  let cleaned = text;
  let match: RegExpExecArray | null;

  // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex exec loop
  while ((match = fence.exec(text)) !== null) {
    const body = match[1]?.trim();
    if (!body) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      continue;
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
    if (consumed) cleaned = cleaned.replace(match[0], "");
  }

  return { calls, cleaned: cleaned.trim() };
}
