import { promises as fs } from "node:fs";
import type { Tool, ToolResult } from "@arterm/core";
import { optionalString, requireString, resolveWithin } from "./paths.js";
import { runProjectCommand } from "./project.js";

/** Lines returned when the caller does not say. */
const DEFAULT_LINES = 100;
/** Ceiling on `lines`, so one call cannot ask for a whole log file. */
const MAX_LINES = 2000;
/** Bytes read off the END of a file — enough for MAX_LINES of almost anything. */
const TAIL_BYTES = 1_000_000;

type Source = "file" | "docker" | "systemd";

/**
 * Read the last `lines` lines of a file without reading the file.
 *
 * This is the part `read` genuinely cannot do. `read` pages forward from an
 * offset, so reaching the end of a 200 MB log means knowing the line count
 * first — which means reading it. A log's answer is always at the end, the
 * same reason `clampMiddle` keeps the tail.
 */
async function tailFile(abs: string, lines: number): Promise<string> {
  const handle = await fs.open(abs, "r");
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - TAIL_BYTES);
    const length = size - start;
    const buf = Buffer.alloc(Number(length));
    await handle.read(buf, 0, Number(length), start);
    const text = buf.toString("utf8");
    // A partial first line, when the window started mid-line.
    const body = start > 0 ? text.slice(text.indexOf("\n") + 1) : text;
    const all = body.split("\n");
    const kept = all.slice(Math.max(0, all.length - lines));
    const note =
      start > 0 || all.length > kept.length
        ? `\n[last ${kept.length} line(s) of ${abs}${start > 0 ? `, read from the final ${TAIL_BYTES} bytes` : ""}]`
        : "";
    return kept.join("\n") + note;
  } finally {
    await handle.close();
  }
}

export const logsTool: Tool = {
  name: "logs",
  maxOutputBytes: 65_536,
  description:
    "Read the END of a log: a file's last lines, a docker container's output, or a systemd " +
    "unit's journal. Optionally filtered by a regular expression.",
  usageHint:
    "Use this rather than `read` when you want the end of something — `read` pages forward from " +
    "a line number, so reaching the tail of a large log means knowing its length first. " +
    "`target` means whatever `source` says: a path for 'file', a container name or id for " +
    "'docker', a unit name for 'systemd'. Narrow with `filter` before raising `lines`; a " +
    "regular expression applied here costs nothing, and 2000 unfiltered lines cost the context.",
  permission: "allow",
  category: "read",
  riskTier: "safe",
  parameters: {
    type: "object",
    properties: {
      target: {
        type: "string",
        description: "File path, docker container, or systemd unit — per `source`.",
      },
      source: {
        type: "string",
        enum: ["file", "docker", "systemd"],
        description: "Where to read from (default 'file').",
      },
      lines: { type: "number", description: `Lines from the end (default ${DEFAULT_LINES}).` },
      filter: { type: "string", description: "Keep only lines matching this regular expression." },
    },
    required: ["target"],
  },
  preview: (args) => `logs ${String(args.source ?? "file")}:${String(args.target)}`,
  async execute(args, ctx) {
    const target = requireString(args, "target");
    const source = (optionalString(args, "source") ?? "file") as Source;
    const lines = Math.max(
      1,
      Math.min(MAX_LINES, Math.floor(toNumber(args.lines) ?? DEFAULT_LINES)),
    );

    let filter: RegExp | undefined;
    const filterText = optionalString(args, "filter");
    if (filterText) {
      try {
        filter = new RegExp(filterText);
      } catch (err) {
        return { output: `Invalid filter regex: ${(err as Error).message}`, isError: true };
      }
    }

    let result: ToolResult;
    if (source === "file") {
      // A log path is a path: the same confinement every file-taking tool gets.
      // Without it this would be the read tool with the guard left off.
      const abs = resolveWithin(ctx.cwd, target);
      try {
        result = { output: await tailFile(abs, lines) };
      } catch (err) {
        return { output: `Cannot read ${target}: ${(err as Error).message}`, isError: true };
      }
    } else if (source === "docker") {
      result = await runProjectCommand("docker", ["logs", "--tail", String(lines), target], ctx);
      if (result.isError && /ENOENT|not found/i.test(result.output)) {
        return { output: "docker is not installed or not on PATH.", isError: true };
      }
    } else {
      result = await runProjectCommand(
        "journalctl",
        ["-u", target, "-n", String(lines), "--no-pager"],
        ctx,
      );
      if (result.isError && /ENOENT|not found/i.test(result.output)) {
        return { output: "journalctl is not available on this system.", isError: true };
      }
    }

    if (!filter || result.isError) return result;
    const kept = result.output.split("\n").filter((l) => filter.test(l));
    if (kept.length === 0) {
      return { output: `No line in the last ${lines} matched /${filterText}/.` };
    }
    // What the filter removed, stated: a filtered view that does not say it is
    // filtered reads as the whole log, and an absent line reads as a fact.
    return {
      output: `${kept.join("\n")}\n[${kept.length} of the last ${lines} line(s) matched /${filterText}/]`,
    };
  },
};

function toNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
