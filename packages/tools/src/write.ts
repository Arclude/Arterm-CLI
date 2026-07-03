import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import { type Tool, lineDiff, writePreview } from "@arterm/core";
import { requireString, resolveWithin } from "./paths.js";
import { invalidateSearchIndex } from "./search.js";

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
  preview: (args) =>
    writePreview(String(args.path), typeof args.content === "string" ? args.content : ""),
  async execute(args, ctx) {
    const relPath = requireString(args, "path");
    const abs = resolveWithin(ctx.cwd, relPath);
    const content = requireString(args, "content");
    // Read the prior content (if any) so an overwrite renders as a real diff.
    const before = await fs.readFile(abs, "utf8").catch(() => "");
    await fs.mkdir(dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, "utf8");
    invalidateSearchIndex(ctx.cwd);
    return {
      output: `Wrote ${content.length} bytes to ${relPath}`,
      diff: lineDiff(before, content),
      path: relPath,
    };
  },
};
