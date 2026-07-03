import { promises as fs } from "node:fs";
import { type Tool, lineDiff, multiEditPreview } from "@arterm/core";
import { requireString, resolveWithin } from "./paths.js";
import { invalidateSearchIndex } from "./search.js";

interface OneEdit {
  old_string: string;
  new_string: string;
  replace_all: boolean;
}

/** Validate and normalise the `edits` argument into a typed list. */
function asEdits(raw: unknown): OneEdit[] {
  if (!Array.isArray(raw)) throw new Error("edits must be an array");
  return raw.map((e, i) => {
    if (typeof e !== "object" || e === null) throw new Error(`edits[${i}] must be an object`);
    const o = e as Record<string, unknown>;
    if (typeof o.old_string !== "string" || o.old_string.length === 0) {
      throw new Error(`edits[${i}].old_string must be a non-empty string`);
    }
    return {
      old_string: o.old_string,
      new_string: typeof o.new_string === "string" ? o.new_string : "",
      replace_all: o.replace_all === true,
    };
  });
}

export const multiEditTool: Tool = {
  name: "multi_edit",
  description:
    "Apply several exact-substring replacements to ONE file atomically, in order. Each " +
    "edit's old_string must appear exactly once unless its replace_all is true. Edits apply " +
    "sequentially, so a later edit sees the result of earlier ones. If ANY edit fails to " +
    "match, the file is left completely untouched. Prefer this over multiple edit calls on " +
    "the same file.",
  permission: "ask",
  category: "edit",
  mutating: true,
  riskTier: "caution",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path relative to the working directory." },
      edits: {
        type: "array",
        description: "Ordered replacements applied to the file, each as in the edit tool.",
        items: {
          type: "object",
          properties: {
            old_string: { type: "string", description: "Exact text to replace." },
            new_string: { type: "string", description: "Replacement text." },
            replace_all: {
              type: "boolean",
              description: "Replace every occurrence of old_string (default false).",
            },
          },
          required: ["old_string", "new_string"],
        },
      },
    },
    required: ["path", "edits"],
  },
  preview: (args) => {
    try {
      return multiEditPreview(String(args.path), asEdits(args.edits));
    } catch {
      return `multi_edit ${String(args.path)}`;
    }
  },
  async execute(args, ctx) {
    const relPath = requireString(args, "path");
    const abs = resolveWithin(ctx.cwd, relPath);
    let edits: OneEdit[];
    try {
      edits = asEdits(args.edits);
    } catch (e) {
      return { output: (e as Error).message, isError: true };
    }
    if (edits.length === 0) return { output: "edits is empty.", isError: true };

    // Apply to an in-memory copy; persist only if EVERY edit matches (atomic).
    const original = await fs.readFile(abs, "utf8");
    let content = original;
    for (const [i, edit] of edits.entries()) {
      const count = content.split(edit.old_string).length - 1;
      if (count === 0) {
        return { output: `edit ${i + 1}: old_string not found.`, isError: true };
      }
      if (count > 1 && !edit.replace_all) {
        return {
          output: `edit ${i + 1}: old_string is not unique (${count} matches). Add context or set replace_all.`,
          isError: true,
        };
      }
      // index+slice, not String.replace — replace() treats `$&`/`$1`/`$$` in
      // new_string as patterns and would silently corrupt the write.
      const idx = content.indexOf(edit.old_string);
      content = edit.replace_all
        ? content.split(edit.old_string).join(edit.new_string)
        : content.slice(0, idx) + edit.new_string + content.slice(idx + edit.old_string.length);
    }
    await fs.writeFile(abs, content, "utf8");
    invalidateSearchIndex(ctx.cwd);
    return {
      output: `Applied ${edits.length} edit(s) to ${relPath}`,
      diff: lineDiff(original, content),
      path: relPath,
    };
  },
};
