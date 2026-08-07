import { promises as fs } from "node:fs";
import { type Tool, lineDiff } from "@arterm/core";
import { ignorePatterns } from "./ignore.js";
import { assertSafeGlob, isWithin, optionalString, requireString } from "./paths.js";
import { invalidateSearchIndex } from "./search.js";
import { invalidateSymbolIndex } from "./symbols.js";

/** Files changed in one call before it refuses instead of proceeding. */
const DEFAULT_MAX_FILES = 50;
/** A file larger than this is skipped: a pathological pattern on it cannot be interrupted. */
const MAX_FILE_BYTES = 2_000_000;
/** Wall-clock budget for the whole scan, checked between files. */
const DEADLINE_MS = 20_000;

function looksBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8192).includes(0);
}

function escapeLiteral(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface Hit {
  rel: string;
  abs: string;
  before: string;
  after: string;
  count: number;
}

export const replaceTool: Tool = {
  name: "replace",
  description:
    "Search and replace across many files with a regular expression. Set `dry_run` to see " +
    "which files would change first.",
  usageHint:
    "The replacement string is interpreted: `$1` is the first capture group, `$&` the whole " +
    "match, and a literal dollar sign must be written `$$`. Set `literal: true` when the pattern " +
    "is plain text with regex characters in it (a path, a version number) — it is escaped for " +
    "you. Narrow with `glob` before raising `max_files`: the cap exists because one call here " +
    "changes as much as dozens of edits, and a pattern that was slightly too wide is not " +
    "something the next call can undo.",
  permission: "ask",
  category: "edit",
  mutating: true,
  // One call can rewrite the tree. `confirmDestructive` keeps a prompt in front
  // of it even under yolo, which is the point: the argument, not the tool, is
  // what makes this dangerous, and nobody reads a pattern as carefully as a
  // diff.
  riskTier: "destructive",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regular expression to find." },
      replacement: { type: "string", description: "Replacement text ($1 = first group)." },
      glob: { type: "string", description: "Files to search (default '**/*')." },
      literal: { type: "boolean", description: "Treat pattern as plain text, not a regex." },
      ignore_case: { type: "boolean", description: "Case-insensitive match." },
      dry_run: { type: "boolean", description: "Report what would change; write nothing." },
      max_files: {
        type: "number",
        description: `Refuse if more files than this would change (default ${DEFAULT_MAX_FILES}).`,
      },
    },
    required: ["pattern", "replacement"],
  },
  preview: (args) => {
    const where = optionalString(args, "glob") ?? "**/*";
    const head = args.dry_run === true ? "replace (dry run)" : "replace";
    return `${head} /${String(args.pattern)}/ → "${String(args.replacement)}" in ${where}`;
  },
  async execute(args, ctx) {
    const rawPattern = requireString(args, "pattern");
    const replacement = typeof args.replacement === "string" ? args.replacement : "";
    const glob = optionalString(args, "glob") ?? "**/*";
    assertSafeGlob(glob);
    const maxFiles = Math.max(1, Math.floor(numberOr(args.max_files, DEFAULT_MAX_FILES)));

    const source = args.literal === true ? escapeLiteral(rawPattern) : rawPattern;
    const flags = `gm${args.ignore_case === true ? "i" : ""}`;
    let re: RegExp;
    try {
      re = new RegExp(source, flags);
    } catch (err) {
      return { output: `Invalid regex: ${(err as Error).message}`, isError: true };
    }
    // A pattern that matches nothing at all inserts the replacement between
    // every character of every file. There is no case where that was the ask.
    if (new RegExp(source, flags.replace("g", "")).test("")) {
      return {
        output: `Pattern /${source}/ matches the empty string, which would rewrite every position in every file. Make it match something.`,
        isError: true,
      };
    }

    const { default: fg } = await import("fast-glob");
    const files = await fg(glob, {
      cwd: ctx.cwd,
      ignore: await ignorePatterns(ctx.cwd),
      onlyFiles: true,
      absolute: true,
      followSymbolicLinks: false,
      suppressErrors: true,
    });

    const hits: Hit[] = [];
    let skipped = 0;
    const deadline = Date.now() + DEADLINE_MS;
    for (const abs of files) {
      if (ctx.signal?.aborted) return { output: "Cancelled.", isError: true };
      if (Date.now() > deadline) {
        return {
          output: `Gave up after ${DEADLINE_MS}ms scanning ${files.length} file(s) — narrow \`glob\`, or simplify the pattern.`,
          isError: true,
        };
      }
      if (!isWithin(ctx.cwd, abs)) continue;
      let buf: Buffer;
      try {
        buf = await fs.readFile(abs);
      } catch {
        continue;
      }
      if (buf.length > MAX_FILE_BYTES || looksBinary(buf)) {
        skipped++;
        continue;
      }
      const before = buf.toString("utf8");
      re.lastIndex = 0;
      const count = before.match(re)?.length ?? 0;
      if (count === 0) continue;
      re.lastIndex = 0;
      const after = before.replace(re, replacement);
      if (after === before) continue;
      hits.push({ rel: abs.slice(ctx.cwd.length + 1), abs, before, after, count });
    }

    if (hits.length === 0) {
      const note = skipped > 0 ? ` (${skipped} binary/oversized file(s) skipped)` : "";
      return { output: `No file matched /${source}/ in ${glob}.${note}` };
    }
    // Counted before anything is written: a cap that stops halfway leaves the
    // tree in a state neither the model nor the user asked for.
    if (hits.length > maxFiles) {
      return {
        output: `Refused: ${hits.length} file(s) would change, over the cap of ${maxFiles}. Narrow \`glob\`, or raise \`max_files\` deliberately.\nFirst matches: ${hits
          .slice(0, 10)
          .map((h) => h.rel)
          .join(", ")}`,
        isError: true,
      };
    }

    const total = hits.reduce((n, h) => n + h.count, 0);
    const list = hits.map((h) => `  ${h.rel} · ${h.count}`).join("\n");

    if (args.dry_run === true) {
      return {
        output: `Would replace ${total} occurrence(s) in ${hits.length} file(s):\n${list}`,
        ...(hits[0] ? { diff: lineDiff(hits[0].before, hits[0].after), path: hits[0].rel } : {}),
      };
    }

    for (const hit of hits) await fs.writeFile(hit.abs, hit.after, "utf8");
    invalidateSearchIndex(ctx.cwd);
    invalidateSymbolIndex(ctx.cwd);

    const skippedNote = skipped > 0 ? `\n[${skipped} binary/oversized file(s) skipped]` : "";
    return {
      output: `Replaced ${total} occurrence(s) in ${hits.length} file(s):\n${list}${skippedNote}`,
      ...(hits[0] ? { diff: lineDiff(hits[0].before, hits[0].after), path: hits[0].rel } : {}),
    };
  },
};

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
