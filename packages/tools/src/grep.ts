import { promises as fs } from "node:fs";
import type { Tool } from "@arterm/core";
import { ignorePatterns } from "./ignore.js";
import { assertSafeGlob, isWithin, optionalString, requireString } from "./paths.js";

const MAX_MATCHES = 100;

export const grepTool: Tool = {
  name: "grep",
  maxOutputBytes: 131_072,
  description: "Search file contents for a regular expression and return matching lines.",
  // `grep` and `search` are near-synonyms in the roster and answer different
  // questions: one finds a literal string, the other finds relevant code. A
  // model with both and no guidance reaches for grep and then greps again.
  selection: {
    doNotUseWhen: "finding code by what it does",
    useInstead: "search (ranked over the code index)",
  },
  usageHint:
    "The pattern is a JavaScript regular expression, not a shell glob — `foo.*bar`, not `foo*bar`. " +
    "Narrow the search with `glob` (e.g. 'src/**/*.ts') rather than filtering the results afterwards. " +
    "Files ignored by the project's .gitignore are never searched.",
  permission: "allow",
  category: "read",
  concurrent: true,
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
      // The project's own `.gitignore` decides, not a three-entry list that
      // only ever matched a TypeScript repo — see `ignore.ts`.
      ignore: await ignorePatterns(ctx.cwd),
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
