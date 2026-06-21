import { promises as fs } from "node:fs";
import type { Tool } from "@arterm/core";
import { requireString, resolveWithin } from "./paths.js";

const MAX_BYTES = 100_000;

export const readTool: Tool = {
  name: "read",
  description: "Read a UTF-8 text file and return its contents with line numbers.",
  permission: "allow",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path relative to the working directory." },
    },
    required: ["path"],
  },
  preview: (args) => `read ${String(args.path)}`,
  async execute(args, ctx) {
    const abs = resolveWithin(ctx.cwd, requireString(args, "path"));
    const buf = await fs.readFile(abs);
    const truncated = buf.length > MAX_BYTES;
    const text = buf.subarray(0, MAX_BYTES).toString("utf8");
    const numbered = text
      .split("\n")
      .map((line, i) => `${String(i + 1).padStart(5)}\t${line}`)
      .join("\n");
    const note = truncated ? `\n... [truncated at ${MAX_BYTES} bytes]` : "";
    return { output: numbered + note };
  },
};
