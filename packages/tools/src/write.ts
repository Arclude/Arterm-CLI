import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import type { Tool } from "@arterm/core";
import { requireString, resolveWithin } from "./paths.js";

export const writeTool: Tool = {
  name: "write",
  description: "Create or overwrite a file with the given content.",
  permission: "ask",
  category: "edit",
  mutating: true,
  riskTier: "caution",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path relative to the working directory." },
      content: { type: "string", description: "Full file content to write." },
    },
    required: ["path", "content"],
  },
  preview: (args) => `write ${String(args.path)} (${String(args.content ?? "").length} bytes)`,
  async execute(args, ctx) {
    const abs = resolveWithin(ctx.cwd, requireString(args, "path"));
    const content = requireString(args, "content");
    await fs.mkdir(dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, "utf8");
    return { output: `Wrote ${content.length} bytes to ${args.path}` };
  },
};
