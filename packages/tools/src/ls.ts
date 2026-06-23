import { promises as fs } from "node:fs";
import type { Tool } from "@arterm/core";
import { optionalString, resolveWithin } from "./paths.js";

export const lsTool: Tool = {
  name: "ls",
  description: "List the entries of a directory (defaults to the working directory).",
  permission: "allow",
  category: "read",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Directory path; defaults to '.'." },
    },
  },
  preview: (args) => `ls ${String(args.path ?? ".")}`,
  async execute(args, ctx) {
    const abs = resolveWithin(ctx.cwd, optionalString(args, "path") ?? ".");
    const entries = await fs.readdir(abs, { withFileTypes: true });
    const lines = entries
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
    return { output: lines.join("\n") || "(empty)" };
  },
};
