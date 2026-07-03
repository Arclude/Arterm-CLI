import { Box, Text } from "ink";
import type React from "react";

/**
 * Lightweight markdown rendering for the transcript. The parser is pure (no ink)
 * so it is unit-testable; the `Markdown` component below maps parsed blocks onto
 * ink Text. Deliberately small: headings, bullets, blockquotes, fenced code with
 * token-based highlighting, and inline bold/italic/`code`. Everything else
 * renders as plain text — never throw on weird model output.
 */

export interface MdSpan {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  /** Set by the code highlighter. */
  color?: string;
}

export type MdBlock =
  | { type: "heading"; level: number; spans: MdSpan[] }
  | { type: "paragraph"; spans: MdSpan[] }
  | { type: "bullet"; indent: number; spans: MdSpan[] }
  | { type: "quote"; spans: MdSpan[] }
  | { type: "code"; lang: string; lines: string[] }
  | { type: "blank" };

/** Inline emphasis: `code` first (its content is opaque), then **bold**, then *italic*. */
const INLINE_RE = /(`[^`]+`)|(\*\*[^*]+?\*\*)|(\*[^*\s][^*]*?\*)|(__[^_]+?__)|(_[^_\s][^_]*?_)/g;

export function parseInline(text: string): MdSpan[] {
  const spans: MdSpan[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE_RE)) {
    const idx = match.index ?? 0;
    if (idx > last) spans.push({ text: text.slice(last, idx) });
    const token = match[0];
    if (token.startsWith("`")) {
      spans.push({ text: token.slice(1, -1), code: true });
    } else if (token.startsWith("**") || token.startsWith("__")) {
      spans.push({ text: token.slice(2, -2), bold: true });
    } else {
      spans.push({ text: token.slice(1, -1), italic: true });
    }
    last = idx + token.length;
  }
  if (last < text.length) spans.push({ text: text.slice(last) });
  return spans.length > 0 ? spans : [{ text: "" }];
}

const KEYWORDS = new Set([
  // Shared across the languages local models emit most (JS/TS, Python, Go, Rust, shell).
  ...(
    "const let var function return if else for while switch case break continue new class " +
    "extends import export from async await try catch finally throw typeof interface type " +
    "def elif lambda pass raise with as in not and or is None True False print " +
    "fn pub mut impl struct enum match use mod func go defer chan package " +
    "echo fi then do done esac local"
  ).split(" "),
]);

/** Token-colors one line of code. Regex-based and approximate by design. */
export function highlightCode(line: string): MdSpan[] {
  const spans: MdSpan[] = [];
  // comment | string | number | word | anything else
  const re =
    /(\/\/.*|#.*)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\b\d[\d_.]*\b)|([A-Za-z_][A-Za-z0-9_]*)|(\s+|[^\s\w]+)/g;
  for (const match of line.matchAll(re)) {
    const [token, comment, str, num, word] = match;
    if (comment) spans.push({ text: comment, color: "gray" });
    else if (str) spans.push({ text: str, color: "yellow" });
    else if (num) spans.push({ text: num, color: "cyan" });
    else if (word) spans.push({ text: word, color: KEYWORDS.has(word) ? "magenta" : undefined });
    else spans.push({ text: token });
  }
  return spans.length > 0 ? spans : [{ text: "" }];
}

export function parseMarkdown(text: string): MdBlock[] {
  const blocks: MdBlock[] = [];
  const lines = text.split("\n");
  let codeLang: string | null = null;
  let codeLines: string[] = [];

  for (const line of lines) {
    const fence = line.match(/^\s*```(\w*)\s*$/);
    if (fence) {
      if (codeLang === null) {
        codeLang = fence[1] ?? "";
        codeLines = [];
      } else {
        blocks.push({ type: "code", lang: codeLang, lines: codeLines });
        codeLang = null;
      }
      continue;
    }
    if (codeLang !== null) {
      codeLines.push(line);
      continue;
    }
    if (line.trim() === "") {
      blocks.push({ type: "blank" });
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading?.[1] !== undefined && heading[2] !== undefined) {
      blocks.push({ type: "heading", level: heading[1].length, spans: parseInline(heading[2]) });
      continue;
    }
    const bullet = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (bullet?.[1] !== undefined && bullet[3] !== undefined) {
      blocks.push({
        type: "bullet",
        indent: Math.floor(bullet[1].length / 2),
        spans: parseInline(bullet[3]),
      });
      continue;
    }
    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote?.[1] !== undefined) {
      blocks.push({ type: "quote", spans: parseInline(quote[1]) });
      continue;
    }
    blocks.push({ type: "paragraph", spans: parseInline(line) });
  }
  // Unterminated fence (mid-stream): show what arrived so far as code.
  if (codeLang !== null) blocks.push({ type: "code", lang: codeLang, lines: codeLines });
  return blocks;
}

function Spans({ spans, base }: { spans: MdSpan[]; base?: { color?: string; bold?: boolean } }) {
  return (
    <Text color={base?.color} bold={base?.bold}>
      {spans.map((s, i) => (
        <Text
          // biome-ignore lint/suspicious/noArrayIndexKey: static span list, never reordered
          key={i}
          bold={s.bold || base?.bold}
          italic={s.italic}
          color={s.code ? "cyanBright" : (s.color ?? base?.color)}
        >
          {s.text}
        </Text>
      ))}
    </Text>
  );
}

/** Renders assistant markdown in the transcript. Falls back gracefully on plain text. */
export function Markdown({ text }: { text: string }): React.ReactElement {
  const blocks = parseMarkdown(text);
  return (
    <Box flexDirection="column">
      {blocks.map((block, i) => {
        const key = i;
        switch (block.type) {
          case "blank":
            return <Text key={key}> </Text>;
          case "heading":
            return (
              <Spans
                key={key}
                spans={block.spans}
                base={{ bold: true, color: block.level <= 2 ? "cyan" : undefined }}
              />
            );
          case "bullet":
            return (
              <Box key={key} paddingLeft={1 + block.indent * 2}>
                <Text color="green">• </Text>
                <Spans spans={block.spans} />
              </Box>
            );
          case "quote":
            return (
              <Box key={key} paddingLeft={1}>
                <Text color="gray">▏ </Text>
                <Spans spans={block.spans} base={{ color: "gray" }} />
              </Box>
            );
          case "code":
            return (
              <Box key={key} flexDirection="column" paddingLeft={2}>
                {block.lang ? (
                  <Text color="gray" dimColor>
                    {block.lang}
                  </Text>
                ) : null}
                {block.lines.map((line, j) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: static code lines
                  <Text key={j} wrap="truncate-end">
                    {highlightCode(line).map((s, k) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: static span list
                      <Text key={k} color={s.color}>
                        {s.text}
                      </Text>
                    ))}
                  </Text>
                ))}
              </Box>
            );
          default:
            return <Spans key={key} spans={block.spans} />;
        }
      })}
    </Box>
  );
}
