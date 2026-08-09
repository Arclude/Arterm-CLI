import { promises as fs } from "node:fs";
import type { Tool, ToolResult } from "@arterm/core";
import { MAX_IMAGE_FILE_BYTES, imageMediaType, sniffImageType } from "@arterm/core";
import { requireString, reservePath, resolveWithin } from "./paths.js";

/** Bytes read off disk before paging is required. */
const MAX_BYTES = 400_000;

/**
 * Return an image file as content the model can look at, or say why not.
 *
 * The format table, the size ceiling and the magic check live in core's
 * `attachments.ts`, shared with the images the USER attaches. Two copies of
 * "is this really a PNG" is one copy that is right and one that is stale.
 */
function readImage(abs: string, buf: Buffer, named: string): ToolResult {
  // The BYTES decide the type, not the name. A `.png` that is really a JPEG is
  // an ordinary file (there is one in the author's own ~/Resimler), and
  // refusing it would fail on the first real photo. Bytes matching NOTHING is
  // still a refusal — that is the HTML-error-page-named-.png case.
  const mediaType = sniffImageType(buf);
  if (!mediaType) {
    return {
      output: `${abs} is named as ${named} but its bytes are not any image format — not sending it.`,
      isError: true,
    };
  }
  if (buf.length > MAX_IMAGE_FILE_BYTES) {
    const over = `${buf.length} bytes, over the ${MAX_IMAGE_FILE_BYTES}-byte limit for an image`;
    return { output: `${abs} is ${over}. Resize or crop it first.`, isError: true };
  }
  return {
    output: `${abs} — ${mediaType}, ${buf.length} bytes, attached as an image.`,
    images: [{ mediaType, data: buf.toString("base64") }],
  };
}
/** Lines returned when the caller does not ask for a window. */
const DEFAULT_LIMIT = 2000;
/** A single line longer than this is clipped — one minified bundle line is not a read. */
const MAX_LINE = 2000;

/**
 * Bytes that mean "this is not text".
 *
 * A NUL in the first few KB is the classic signal, and it is the one that
 * matters: without it a binary file is decoded as UTF-8, and what reaches the
 * model is a screenful of replacement characters that costs tokens and says
 * nothing. Checking a prefix rather than the whole file keeps this cheap on
 * the large files where it matters most.
 */
function looksBinary(buf: Buffer): boolean {
  const probe = buf.subarray(0, 8192);
  if (probe.includes(0)) return true;
  // A high proportion of bytes outside printable ASCII + common control codes.
  let odd = 0;
  for (const byte of probe) {
    if (byte === 9 || byte === 10 || byte === 13) continue;
    if (byte < 32 || byte === 127) odd++;
  }
  return probe.length > 0 && odd / probe.length > 0.3;
}

export const readTool: Tool = {
  name: "read",
  maxOutputBytes: 262_144,
  description:
    "Read a UTF-8 text file with line numbers. Use `offset` and `limit` to read a window of a " +
    "large file. A .png/.jpg/.gif/.webp file is returned as an image instead, so you can look " +
    "at a screenshot or a chart rather than being told it is binary.",
  permission: "allow",
  category: "read",
  concurrent: true,
  reservation: (args, cwd) => reservePath(args, cwd, "read"),
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path relative to the working directory." },
      offset: {
        type: "number",
        description: "1-based line to start at (default 1).",
      },
      limit: {
        type: "number",
        description: `Lines to return (default ${DEFAULT_LIMIT}).`,
      },
    },
    required: ["path"],
  },
  preview: (args) => {
    const at = typeof args.offset === "number" ? `:${args.offset}` : "";
    return `read ${String(args.path)}${at}`;
  },
  async execute(args, ctx) {
    const abs = resolveWithin(ctx.cwd, requireString(args, "path"));
    const buf = await fs.readFile(abs);

    // Before the binary check, not after: every image file trips it, and the
    // refusal is the answer only for the binaries nothing can render.
    const mediaType = imageMediaType(abs);
    if (mediaType) return readImage(abs, buf, mediaType);

    if (looksBinary(buf)) {
      return {
        output: `${abs} looks like a binary file (${buf.length} bytes) — not decoding it as text.`,
        isError: true,
      };
    }

    // Paging is what makes a large file readable at all. Without it the only
    // way to see line 4000 of a 5000-line file was to shell out to `sed -n`,
    // which is a tool call that reads a file without going through the tool
    // that reads files — no path confinement, no size cap, no line numbers.
    const offset = Math.max(1, Math.floor(toNumber(args.offset) ?? 1));
    const limit = Math.max(1, Math.floor(toNumber(args.limit) ?? DEFAULT_LIMIT));

    const clippedBytes = buf.length > MAX_BYTES;
    const lines = buf.subarray(0, MAX_BYTES).toString("utf8").split("\n");
    const total = lines.length;

    if (offset > total) {
      return {
        output: `offset ${offset} is past the end of the file (${total} lines).`,
        isError: true,
      };
    }

    const window = lines.slice(offset - 1, offset - 1 + limit);
    const numbered = window
      .map((line, i) => {
        const n = String(offset + i).padStart(5);
        const body = line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)}… [line clipped]` : line;
        return `${n}\t${body}`;
      })
      .join("\n");

    // What was NOT returned, always — a window with no edges reads as the whole
    // file, and a model that believes it has read the file stops looking.
    const after = total - (offset - 1 + window.length);
    const notes: string[] = [];
    if (offset > 1) notes.push(`${offset - 1} line(s) above`);
    if (after > 0) notes.push(`${after} line(s) below`);
    if (clippedBytes) notes.push(`file exceeds ${MAX_BYTES} bytes and was cut`);
    const note = notes.length > 0 ? `\n[${total} lines total · ${notes.join(" · ")}]` : "";

    return { output: numbered + note };
  },
};

function toNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
