import { promises as fs } from "node:fs";
import { type Tool, unifiedDiff } from "@arterm/core";
import { inGitRepo, runGit } from "./gitRun.js";
import { optionalString, requireString, resolveWithin } from "./paths.js";

/** Body lines emitted before the diff stops and says how much it hid. */
const MAX_LINES = 800;

type Mode = "working" | "staged" | "files" | "commits";

export const diffTool: Tool = {
  name: "diff",
  maxOutputBytes: 131_072,
  description:
    "Show a unified diff: uncommitted changes (working/staged), between two commits, or " +
    "between two files. Set `stat` for just the per-file summary.",
  usageHint:
    "Ask for `stat: true` first when you do not know how large the change is — a summary is a few " +
    "lines where the diff may be thousands, and it tells you which paths to then ask about. " +
    "The output is a real unified diff with a/ and b/ prefixes, so it can be fed to the `patch` " +
    "tool as-is (its default strip of 1 matches). A diff reported as truncated cannot: it is " +
    "missing hunks and patch will refuse it.",
  permission: "allow",
  category: "read",
  concurrent: true,
  riskTier: "safe",
  parameters: {
    type: "object",
    properties: {
      mode: {
        type: "string",
        enum: ["working", "staged", "files", "commits"],
        description: "What to compare (default 'working': unstaged changes).",
      },
      path: {
        type: "string",
        description: "In 'files' mode the first file; otherwise an optional path filter.",
      },
      other: { type: "string", description: "The second file, in 'files' mode." },
      from: { type: "string", description: "Base ref, in 'commits' mode." },
      to: { type: "string", description: "Target ref, in 'commits' mode (default HEAD)." },
      stat: { type: "boolean", description: "Return only the per-file summary." },
      context: { type: "number", description: "Lines of context around each change (default 3)." },
    },
  },
  preview: (args) => {
    const mode = String(args.mode ?? "working");
    if (mode === "files") return `diff ${String(args.path)} ${String(args.other)}`;
    if (mode === "commits") return `diff ${String(args.from)}..${String(args.to ?? "HEAD")}`;
    return `diff (${mode})`;
  },
  async execute(args, ctx) {
    const mode = (optionalString(args, "mode") ?? "working") as Mode;
    const context = Math.max(0, Math.min(20, Math.floor(toNumber(args.context) ?? 3)));
    const stat = args.stat === true;

    if (mode === "files") return diffFiles(args, ctx.cwd, context, stat);

    if (!(await inGitRepo(ctx.cwd, ctx.signal))) {
      return {
        output: `'${mode}' compares against git history, and ${ctx.cwd} is not a git work tree. Use mode 'files' to compare two files directly.`,
        isError: true,
      };
    }

    // --no-color because a user's `color.ui = always` would otherwise put ANSI
    // escapes inside the patch body, where they are content: the diff still
    // reads fine and stops being applicable.
    //
    // `-U<n>` is withheld under --stat rather than passed alongside it: -U
    // IMPLIES --patch, so asking for both returns the whole diff after the
    // summary — which is exactly the output `stat` exists to avoid, and it
    // arrives looking like it worked.
    const argv = ["--no-pager", "diff", "--no-color", stat ? "--stat" : `-U${context}`];
    if (mode === "staged") argv.push("--cached");
    if (mode === "commits") {
      const from = optionalString(args, "from");
      if (!from) return { output: "mode 'commits' needs `from`.", isError: true };
      argv.push(from, optionalString(args, "to") ?? "HEAD");
    }
    const filter = optionalString(args, "path");
    if (filter) {
      resolveWithin(ctx.cwd, filter);
      argv.push("--", filter);
    }

    const r = await runGit(argv, ctx.cwd, { signal: ctx.signal, credentials: ctx.credentials });
    if (!r.ok) {
      return { output: r.stderr.trim() || `git diff exited ${r.exitCode}`, isError: true };
    }
    if (r.stdout.trim() === "") return { output: `(no changes: ${mode})` };
    return { output: clampLines(r.stdout) };
  },
};

async function diffFiles(
  args: Record<string, unknown>,
  cwd: string,
  context: number,
  stat: boolean,
) {
  const aRel = requireString(args, "path");
  const bRel = requireString(args, "other");
  const aAbs = resolveWithin(cwd, aRel);
  const bAbs = resolveWithin(cwd, bRel);

  const [a, b] = await Promise.all([readMaybe(aAbs), readMaybe(bAbs)]);
  if (a === undefined) return { output: `Cannot read ${aRel}.`, isError: true };
  if (b === undefined) return { output: `Cannot read ${bRel}.`, isError: true };

  const r = unifiedDiff(a, b, {
    fromFile: aRel,
    toFile: bRel,
    context,
    maxLines: MAX_LINES,
  });
  if (r.text === "") return { output: `(identical: ${aRel} and ${bRel})` };

  const summary = `${r.hunks} hunk(s), +${r.added} -${r.removed}`;
  if (stat) return { output: `${aRel} → ${bRel}: ${summary}` };
  const warn = r.truncated
    ? "\n[truncated — hunks are missing, this will not apply as a patch]"
    : "";
  return { output: `${r.text}[${summary}]${warn}` };
}

async function readMaybe(abs: string): Promise<string | undefined> {
  try {
    return await fs.readFile(abs, "utf8");
  } catch {
    return undefined;
  }
}

/** Bound git's own output the same way, and say what was dropped. */
function clampLines(text: string): string {
  const lines = text.split("\n");
  if (lines.length <= MAX_LINES) return text;
  return [
    ...lines.slice(0, MAX_LINES),
    `… ${lines.length - MAX_LINES} more line(s) — narrow with \`path\`, or ask for \`stat\` first.`,
    "[truncated — hunks are missing, this will not apply as a patch]",
  ].join("\n");
}

function toNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
