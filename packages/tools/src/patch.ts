import { promises as fs } from "node:fs";
import { type Tool, patchTargets } from "@arterm/core";
import { runGit } from "./gitRun.js";
import { requireString, resolveWithin } from "./paths.js";
import { invalidateSearchIndex } from "./search.js";
import { invalidateSymbolIndex } from "./symbols.js";

/** Bytes of patch text accepted in one call. */
const MAX_PATCH_BYTES = 1_000_000;

export const patchTool: Tool = {
  name: "patch",
  description:
    "Apply a unified diff to the working directory. Set `dry_run` to check whether it would " +
    "apply without touching anything.",
  usageHint:
    "The patch must be a real unified diff: a `--- a/path` and `+++ b/path` pair per file, then " +
    "`@@` hunks. `strip` says how many leading path components to drop and defaults to 1, which " +
    "matches the a/ and b/ prefixes git and the `diff` tool produce — pass 0 for a diff with bare " +
    "paths. Prefer `edit` for one or two known replacements; a patch is worth it when a change " +
    "spans several files or several places in one file. If it fails to apply, re-read the file " +
    "rather than adjusting the hunk headers by hand — the context has moved, not the line count.",
  permission: "ask",
  category: "edit",
  mutating: true,
  riskTier: "caution",
  parameters: {
    type: "object",
    properties: {
      patch: { type: "string", description: "The unified diff to apply." },
      strip: { type: "number", description: "Leading path components to drop (default 1)." },
      dry_run: { type: "boolean", description: "Report whether it applies; change nothing." },
      reject: {
        type: "boolean",
        description: "Apply what fits and write failed hunks to .rej files instead of failing.",
      },
    },
    required: ["patch"],
  },
  preview: (args) => {
    const text = String(args.patch ?? "");
    const files = patchTargets(text, numberOr(args.strip, 1));
    const head = args.dry_run === true ? "patch (dry run)" : "patch";
    const body = text
      .split("\n")
      .filter((l) => l.startsWith("+") || l.startsWith("-"))
      .filter((l) => !l.startsWith("+++") && !l.startsWith("---"));
    const shown = body.slice(0, 20);
    if (body.length > shown.length) shown.push(`…${body.length - shown.length} more line(s)`);
    return [`${head} · ${files.length} file(s): ${files.join(", ")}`, ...shown].join("\n");
  },
  async execute(args, ctx) {
    const raw = requireString(args, "patch");
    if (Buffer.byteLength(raw, "utf8") > MAX_PATCH_BYTES) {
      return { output: `Patch is larger than ${MAX_PATCH_BYTES} bytes.`, isError: true };
    }
    // git reads a patch that does not end in a newline as corrupt, and a model
    // emitting one is the common case rather than the odd one.
    const text = raw.endsWith("\n") ? raw : `${raw}\n`;
    const strip = Math.max(0, Math.floor(numberOr(args.strip, 1)));

    const targets = patchTargets(text, strip);
    if (targets.length === 0) {
      return {
        output:
          "No `--- ` / `+++ ` file headers found — this is not a unified diff. " +
          "Each file needs a header pair before its @@ hunks.",
        isError: true,
      };
    }

    // The boundary, and the reason this is not just a shell-out. `git apply`
    // refuses a lexical `..` and bounds paths by the REPOSITORY — so a patch
    // applied from packages/tools can legally write to packages/cli, outside
    // the directory the agent was pointed at and outside what the permission
    // prompt described. `resolveWithin` re-checks after realpath, which is also
    // what a symlink planted inside the tree would otherwise walk through.
    for (const target of targets) {
      try {
        resolveWithin(ctx.cwd, target);
      } catch {
        return {
          output: `Patch refused: it writes to ${target}, which is outside the working directory.`,
          isError: true,
        };
      }
    }

    const base = ["apply", `-p${strip}`];
    if (args.dry_run === true) base.push("--check");
    if (args.reject === true) base.push("--reject");

    const run = (argv: string[]) =>
      runGit(argv, ctx.cwd, {
        input: text,
        signal: ctx.signal,
        credentials: ctx.credentials,
      });

    let result = await run(base);
    let recounted = false;
    if (!result.ok) {
      // The most common defect in a hand-written diff is a hunk header whose
      // counts do not match its body. `--recount` derives them from the body,
      // which is the intended repair — but it is reported, never silent: a
      // fuzzy application nobody was told about is how the wrong lines change.
      //
      // Retried unconditionally rather than when the message looks right:
      // git's stderr is translated, so matching on its wording works on the
      // machine it was written on and nowhere else.
      const retry = await run([...base, "--recount"]);
      if (retry.ok) {
        result = retry;
        recounted = true;
      }
    }

    if (!result.ok && args.reject !== true) {
      const why = result.stderr.trim() || `git apply exited ${result.exitCode}`;
      const missing = /not found|No such file/i.test(why)
        ? "\nThe patch names a file that does not exist — check the paths and `strip`."
        : "\nRe-read the file: the surrounding lines have moved since the patch was written.";
      return { output: `Patch did not apply.\n${why}${missing}`, isError: true };
    }

    if (args.dry_run === true) {
      return {
        output: `Patch applies cleanly to ${targets.length} file(s): ${targets.join(", ")}${
          recounted ? "\n[hunk header counts were wrong and were recomputed]" : ""
        }`,
      };
    }

    invalidateSearchIndex(ctx.cwd);
    invalidateSymbolIndex(ctx.cwd);

    const rejects: string[] = [];
    for (const target of targets) {
      const rej = `${resolveWithin(ctx.cwd, target)}.rej`;
      if (await exists(rej)) rejects.push(`${target}.rej`);
    }

    const notes: string[] = [];
    if (recounted) notes.push("hunk header counts were wrong and were recomputed");
    if (rejects.length > 0) {
      notes.push(`${rejects.length} hunk file(s) rejected: ${rejects.join(", ")}`);
    }
    if (result.stderr.trim()) notes.push(result.stderr.trim());

    return {
      output: `Applied to ${targets.length} file(s): ${targets.join(", ")}${
        notes.length > 0 ? `\n[${notes.join(" · ")}]` : ""
      }`,
      // A partial application is a failure the model has to see, even though
      // the files did change — otherwise it moves on with rejected hunks on disk.
      isError: rejects.length > 0,
    };
  },
};

async function exists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
