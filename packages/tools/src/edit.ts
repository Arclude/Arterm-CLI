import { promises as fs } from "node:fs";
import { type Tool, editPreview } from "@arterm/core";
import { requireString, resolveWithin } from "./paths.js";

export const editTool: Tool = {
  name: "edit",
  description:
    "Replace an exact substring in a file. old_string must appear exactly once unless " +
    "replace_all is true. Read the file first to craft a unique old_string.",
  permission: "ask",
  category: "edit",
  mutating: true,
  riskTier: "caution",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path relative to the working directory." },
      old_string: { type: "string", description: "Exact text to replace." },
      new_string: { type: "string", description: "Replacement text." },
      replace_all: { type: "boolean", description: "Replace every occurrence (default false)." },
    },
    required: ["path", "old_string", "new_string"],
  },
  preview: (args) =>
    editPreview(
      String(args.path),
      typeof args.old_string === "string" ? args.old_string : "",
      typeof args.new_string === "string" ? args.new_string : "",
      args.replace_all === true,
    ),
  async execute(args, ctx) {
    const abs = resolveWithin(ctx.cwd, requireString(args, "path"));
    const oldStr = requireString(args, "old_string");
    const newStr = typeof args.new_string === "string" ? args.new_string : "";
    const replaceAll = args.replace_all === true;

    const content = await fs.readFile(abs, "utf8");
    const count = content.split(oldStr).length - 1;
    if (count === 0) {
      return { output: "old_string not found in file.", isError: true };
    }
    if (count > 1 && !replaceAll) {
      return {
        output: `old_string is not unique (${count} matches). Add context or set replace_all.`,
        isError: true,
      };
    }
    // NB: use index+slice, not String.replace — replace() interprets `$&`, `$1`,
    // `$$` etc. in new_string as patterns and would silently corrupt the write.
    const idx = content.indexOf(oldStr);
    const updated = replaceAll
      ? content.split(oldStr).join(newStr)
      : content.slice(0, idx) + newStr + content.slice(idx + oldStr.length);
    await fs.writeFile(abs, updated, "utf8");
    return { output: `Replaced ${replaceAll ? count : 1} occurrence(s) in ${args.path}` };
  },
};
