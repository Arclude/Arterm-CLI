import { promises as fs } from "node:fs";
import { extname } from "node:path";
import type { Tool } from "@arterm/core";
import { optionalString, requireString, resolveWithin } from "./paths.js";

/** Rendered value bytes returned before the answer is cut. */
const MAX_VALUE_BYTES = 32_768;

type Format = "json" | "json5" | "yaml";

interface Parsed {
  data: unknown;
  format: Format;
  /** True when strict JSON.parse failed and JSON5 rescued it (comments, trailing commas). */
  lenient: boolean;
  /** The file's own indent, so a rewrite does not reformat every line. */
  indent: number;
  trailingNewline: boolean;
}

/**
 * Split a query into path steps.
 *
 * Supports `a.b`, `a[0]` and `a["key.with.dots"]` — the bracket form exists
 * because dependency and script names routinely contain dots and slashes
 * (`@arterm/core`, `test:watch`), and a dotted-only parser silently looks up
 * the wrong key rather than failing.
 */
export function parseQuery(query: string): Array<string | number> {
  const steps: Array<string | number> = [];
  let i = 0;
  while (i < query.length) {
    const ch = query[i];
    if (ch === ".") {
      i++;
      continue;
    }
    if (ch === "[") {
      const close = query.indexOf("]", i);
      if (close === -1) throw new Error(`Unclosed '[' in query at position ${i}`);
      let inner = query.slice(i + 1, close).trim();
      if (
        (inner.startsWith('"') && inner.endsWith('"')) ||
        (inner.startsWith("'") && inner.endsWith("'"))
      ) {
        inner = inner.slice(1, -1);
        steps.push(inner);
      } else if (/^-?\d+$/.test(inner)) {
        steps.push(Number(inner));
      } else {
        steps.push(inner);
      }
      i = close + 1;
      continue;
    }
    let end = i;
    while (end < query.length && query[end] !== "." && query[end] !== "[") end++;
    const name = query.slice(i, end);
    if (name !== "") steps.push(name);
    i = end;
  }
  return steps;
}

function getIn(root: unknown, steps: Array<string | number>): unknown {
  let cur = root;
  for (const step of steps) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string | number, unknown>)[step];
  }
  return cur;
}

/** Objects merge key-by-key; arrays and scalars replace. */
export function deepMerge(base: unknown, patch: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = k in out ? deepMerge(out[k], v) : v;
  }
  return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function formatOf(path: string): Format {
  const ext = extname(path).toLowerCase();
  if (ext === ".yaml" || ext === ".yml") return "yaml";
  if (ext === ".json5" || ext === ".jsonc") return "json5";
  return "json";
}

/** Indent width the file already uses, so a rewrite matches it. */
function detectIndent(text: string): number {
  const m = text.match(/\n([ \t]+)\S/);
  const lead = m?.[1] ?? "  ";
  return lead.startsWith("\t") ? 1 : lead.length;
}

async function parseFile(abs: string, rel: string): Promise<Parsed> {
  const text = await fs.readFile(abs, "utf8");
  const indent = detectIndent(text);
  const trailingNewline = text.endsWith("\n");
  const format = formatOf(rel);

  if (format === "yaml") {
    const YAML = await import("yaml");
    return { data: YAML.parse(text), format, lenient: false, indent, trailingNewline };
  }
  if (format === "json") {
    try {
      return { data: JSON.parse(text), format, lenient: false, indent, trailingNewline };
    } catch (strict) {
      // tsconfig.json and friends are named .json and are not JSON — comments
      // and trailing commas are the norm there. Falling back is what makes the
      // tool usable on real repositories; saying so is what keeps a later
      // write from quietly deleting those comments.
      try {
        const JSON5 = (await import("json5")).default;
        return { data: JSON5.parse(text), format, lenient: true, indent, trailingNewline };
      } catch {
        throw strict;
      }
    }
  }
  const JSON5 = (await import("json5")).default;
  return { data: JSON5.parse(text), format, lenient: true, indent, trailingNewline };
}

function clip(text: string): string {
  if (Buffer.byteLength(text, "utf8") <= MAX_VALUE_BYTES) return text;
  return `${text.slice(0, MAX_VALUE_BYTES)}\n… value truncated — narrow the query`;
}

/** One line per key: name, type, and the size of anything nested. */
function describeKeys(value: unknown): string {
  if (Array.isArray(value)) {
    return value.length === 0
      ? "(empty array)"
      : value.map((v, i) => `[${i}] ${typeName(v)}`).join("\n");
  }
  if (isPlainObject(value)) {
    const keys = Object.entries(value);
    return keys.length === 0
      ? "(empty object)"
      : keys.map(([k, v]) => `${k}: ${typeName(v)}`).join("\n");
  }
  return `(${typeName(value)}, not a container)`;
}

function typeName(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return `array[${v.length}]`;
  if (isPlainObject(v)) return `object{${Object.keys(v).length}}`;
  return typeof v;
}

export const jsonTool: Tool = {
  name: "json",
  maxOutputBytes: 65_536,
  description:
    "Read or change one value inside a JSON, JSONC or YAML file by query path " +
    '(e.g. scripts.build, workspaces[0], dependencies["@arterm/core"]).',
  usageHint:
    "Use `keys` to see what is at a level before asking for it — that is how you navigate a large " +
    "manifest without reading the whole file. `set` and `merge` take `value` as JSON text, so a " +
    'string value is `"text"` (with the quotes) and an object is `{"a":1}`. A YAML file keeps its ' +
    "comments and formatting through a write; a .json file that only parses because it has " +
    "comments is refused for writing, because rewriting it would delete them.",
  permission: "ask",
  category: "edit",
  mutating: true,
  riskTier: "caution",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path relative to the working directory." },
      action: {
        type: "string",
        enum: ["get", "keys", "set", "merge", "validate"],
        description: "What to do (default 'get').",
      },
      query: {
        type: "string",
        description: "Path to the value; omit for the whole document.",
      },
      value: {
        type: "string",
        description: "JSON text to write, for 'set' and 'merge'.",
      },
    },
    required: ["path"],
  },
  preview: (args) => {
    const action = String(args.action ?? "get");
    const q = args.query ? ` ${String(args.query)}` : "";
    const v = args.value ? ` = ${String(args.value).slice(0, 60)}` : "";
    return `json ${action} ${String(args.path)}${q}${v}`;
  },
  async execute(args, ctx) {
    const rel = requireString(args, "path");
    const abs = resolveWithin(ctx.cwd, rel);
    const action = optionalString(args, "action") ?? "get";
    const queryText = optionalString(args, "query") ?? "";

    let doc: Parsed;
    try {
      doc = await parseFile(abs, rel);
    } catch (err) {
      const why = (err as Error).message;
      if (action === "validate") return { output: `${rel} is not valid: ${why}`, isError: true };
      return { output: `Cannot parse ${rel}: ${why}`, isError: true };
    }

    let steps: Array<string | number>;
    try {
      steps = queryText === "" ? [] : parseQuery(queryText);
    } catch (err) {
      return { output: (err as Error).message, isError: true };
    }

    if (action === "validate") {
      const how = doc.lenient
        ? " (parsed as JSON5 — it has comments or trailing commas, which strict JSON forbids)"
        : "";
      return { output: `${rel} parses as ${doc.format}${how}.` };
    }

    if (action === "get" || action === "keys") {
      const value = getIn(doc.data, steps);
      if (value === undefined) {
        const at = queryText === "" ? "the document" : queryText;
        return { output: `No value at ${at} in ${rel}.`, isError: true };
      }
      if (action === "keys") return { output: clip(describeKeys(value)) };
      return { output: clip(JSON.stringify(value, null, 2) ?? String(value)) };
    }

    if (action !== "set" && action !== "merge") {
      return { output: `Unknown action: ${action}`, isError: true };
    }

    const valueText = optionalString(args, "value");
    if (valueText === undefined) {
      return { output: `Action '${action}' needs \`value\` (JSON text).`, isError: true };
    }
    let value: unknown;
    try {
      value = JSON.parse(valueText);
    } catch (err) {
      return { output: `\`value\` is not valid JSON: ${(err as Error).message}`, isError: true };
    }
    if (action === "merge" && !isPlainObject(value)) {
      return { output: "`merge` needs an object value.", isError: true };
    }
    if (steps.length === 0 && action === "set") {
      return {
        output: "`set` needs a `query`; use `merge` to change the whole document.",
        isError: true,
      };
    }
    // JSON5.stringify has nowhere to put the comments back, so a write here
    // would silently delete them. Refusing is the honest answer — the caller
    // can still use `edit`, which changes only the lines it names.
    if (doc.lenient) {
      return {
        output: `${rel} has comments or trailing commas, so writing it would delete them. Use \`edit\` for this file.`,
        isError: true,
      };
    }

    const before = await fs.readFile(abs, "utf8");
    let after: string;
    if (doc.format === "yaml") {
      const YAML = await import("yaml");
      // The Document API, not parse+stringify: a round trip through plain
      // objects loses every comment and every bit of formatting in the file.
      const parsed = YAML.parseDocument(before);
      if (action === "set") parsed.setIn(steps, value);
      else {
        const target = steps.length === 0 ? parsed.toJS() : getIn(doc.data, steps);
        const merged = deepMerge(target, value);
        if (steps.length === 0) {
          const next = YAML.parseDocument(YAML.stringify(merged));
          parsed.contents = next.contents;
        } else parsed.setIn(steps, merged);
      }
      after = parsed.toString();
    } else {
      const next =
        steps.length === 0
          ? deepMerge(doc.data, value)
          : setInPlain(
              doc.data,
              steps,
              action === "set" ? value : deepMerge(getIn(doc.data, steps), value),
            );
      after = JSON.stringify(next, null, doc.indent);
      if (doc.trailingNewline) after += "\n";
    }

    if (after === before) return { output: `${rel} already had that value; nothing written.` };
    await fs.writeFile(abs, after, "utf8");
    const { lineDiff } = await import("@arterm/core");
    return {
      output: `${action === "set" ? "Set" : "Merged into"} ${queryText || "(document)"} in ${rel}.`,
      diff: lineDiff(before, after),
      path: rel,
    };
  },
};

/** Set a value at a path, creating intermediate objects. Returns the new root. */
function setInPlain(root: unknown, steps: Array<string | number>, value: unknown): unknown {
  if (steps.length === 0) return value;
  const [head, ...rest] = steps;
  if (head === undefined) return value;
  if (typeof head === "number" && Array.isArray(root)) {
    const copy = [...root];
    copy[head] = setInPlain(copy[head], rest, value);
    return copy;
  }
  const base = isPlainObject(root) ? { ...root } : {};
  base[String(head)] = setInPlain(base[String(head)], rest, value);
  return base;
}
