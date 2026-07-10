import { promises as fs } from "node:fs";
import type { Tool } from "@arterm/core";
import { assertSafeGlob, isWithin, optionalString, requireString } from "./paths.js";

const MAX_MATCHES = 100;

export const grepTool: Tool = {
  name: "grep",
  description: "Search file contents for a regular expression and return matching lines.",
  permission: "allow",
  category: "read",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regular expression to search for." },
      glob: {
        type: "string",
        description: "Optional file glob to limit the search (default '**/*').",
      },
    },
    required: ["pattern"],
  },
  preview: (args) => `grep /${String(args.pattern)}/`,
  async execute(args, ctx) {
    const pattern = requireString(args, "pattern");
    const glob = optionalString(args, "glob") ?? "**/*";
    assertSafeGlob(glob);
    let regex: RegExp;
    try {
      regex = new RegExp(pattern);
    } catch (err) {
      return { output: `Invalid regex: ${(err as Error).message}`, isError: true };
    }

    // Lazy: fast-glob is loaded on first use, not at startup.
    const { default: fg } = await import("fast-glob");
    const files = await fg(glob, {
      cwd: ctx.cwd,
      ignore: ["**/node_modules/**", "**/dist/**", "**/.git/**"],
      onlyFiles: true,
      absolute: true,
      followSymbolicLinks: false,
    });

    const results: string[] = [];
    for (const file of files) {
      if (results.length >= MAX_MATCHES) break;
      if (!isWithin(ctx.cwd, file)) continue;
      let content: string;
      try {
        content = await fs.readFile(file, "utf8");
      } catch {
        continue;
      }
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i] as string)) {
          const rel = file.slice(ctx.cwd.length + 1);
          results.push(`${rel}:${i + 1}: ${(lines[i] as string).trim()}`);
          if (results.length >= MAX_MATCHES) break;
        }
      }
    }
    return { output: results.join("\n") || "(no matches)" };
  },
};
