import type { Tool } from "@arterm/core";
import fg from "fast-glob";
import { assertSafeGlob, requireString } from "./paths.js";

export const globTool: Tool = {
  name: "glob",
  description: "Find files matching a glob pattern (e.g. 'src/**/*.ts').",
  permission: "allow",
  category: "read",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob pattern relative to the working directory." },
    },
    required: ["pattern"],
  },
  preview: (args) => `glob ${String(args.pattern)}`,
  async execute(args, ctx) {
    const pattern = requireString(args, "pattern");
    assertSafeGlob(pattern);
    const matches = await fg(pattern, {
      cwd: ctx.cwd,
      dot: false,
      ignore: ["**/node_modules/**", "**/dist/**", "**/.git/**"],
      onlyFiles: true,
      followSymbolicLinks: false,
    });
    matches.sort();
    const capped = matches.slice(0, 200);
    const note = matches.length > capped.length ? `\n... (${matches.length} total)` : "";
    return { output: (capped.join("\n") || "(no matches)") + note };
  },
};
