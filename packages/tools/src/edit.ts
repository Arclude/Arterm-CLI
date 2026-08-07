import { promises as fs } from "node:fs";
import { type Tool, editPreview, lineDiff } from "@arterm/core";
import { applyRanges, matchEdit, matched } from "./editMatch.js";
import { requireString, resolveWithin } from "./paths.js";
import { invalidateSearchIndex } from "./search.js";

export const editTool: Tool = {
  name: "edit",
  description:
    "Replace a substring in a file. old_string must identify exactly one place unless " +
    "replace_all is true. Read the file first and copy the text; whitespace differences " +
    "are forgiven, but the match must still be unique.",
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
    const relPath = requireString(args, "path");
    const abs = resolveWithin(ctx.cwd, relPath);
    const oldStr = requireString(args, "old_string");
    const newStr = typeof args.new_string === "string" ? args.new_string : "";
    const replaceAll = args.replace_all === true;

    const content = await fs.readFile(abs, "utf8");
    // The ladder (see `editMatch.ts`): exact first, then progressively more
    // forgiving about whitespace. Exact matching is right and it fails
    // constantly, because the model reconstructs `old_string` from a file it
    // read several turns ago and gets the indentation wrong.
    const result = matchEdit(content, oldStr, newStr, replaceAll);
    if (!matched(result)) {
      const near = (result as { nearest?: { tier: string; count: number } }).nearest;
      return {
        output: near
          ? `old_string is not unique (${near.count} matches at the "${near.tier}" level). Add surrounding context, or set replace_all.`
          : "old_string not found in file — not even ignoring whitespace. Read the file and copy the text exactly.",
        isError: true,
      };
    }

    // NB: ranges + slice, not String.replace — replace() interprets `$&`, `$1`,
    // `$$` etc. in new_string as patterns and would silently corrupt the write.
    const updated = applyRanges(content, result.ranges, result.replacement);
    await fs.writeFile(abs, updated, "utf8");
    invalidateSearchIndex(ctx.cwd);
    // The tier is reported, always. A silent fuzzy match is how an edit lands
    // in the wrong place and nobody finds out until the tests do.
    const how = result.tier === "exact" ? "" : ` (matched on ${result.tier})`;
    return {
      output: `Replaced ${result.ranges.length} occurrence(s) in ${relPath}${how}`,
      diff: lineDiff(content, updated),
      path: relPath,
    };
  },
};
