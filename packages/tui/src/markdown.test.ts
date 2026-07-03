import { describe, expect, it } from "vitest";
import { highlightCode, parseInline, parseMarkdown } from "./markdown.js";

describe("parseInline", () => {
  it("passes plain text through as one span", () => {
    expect(parseInline("hello world")).toEqual([{ text: "hello world" }]);
  });

  it("parses **bold**, *italic*, and `code`", () => {
    expect(parseInline("a **b** c *d* e `f`")).toEqual([
      { text: "a " },
      { text: "b", bold: true },
      { text: " c " },
      { text: "d", italic: true },
      { text: " e " },
      { text: "f", code: true },
    ]);
  });

  it("treats backtick content as opaque (no nested emphasis)", () => {
    expect(parseInline("`**not bold**`")).toEqual([{ text: "**not bold**", code: true }]);
  });

  it("supports __bold__ and _italic_ underscores", () => {
    expect(parseInline("__b__ and _i_")).toEqual([
      { text: "b", bold: true },
      { text: " and " },
      { text: "i", italic: true },
    ]);
  });

  it("does not mistake a lone asterisk for emphasis", () => {
    expect(parseInline("2 * 3 = 6")).toEqual([{ text: "2 * 3 = 6" }]);
  });
});

describe("parseMarkdown", () => {
  it("classifies headings with their level", () => {
    const blocks = parseMarkdown("# Title\n### Sub");
    expect(blocks).toMatchObject([
      { type: "heading", level: 1 },
      { type: "heading", level: 3 },
    ]);
  });

  it("parses bullets (-, *, 1.) with indent", () => {
    const blocks = parseMarkdown("- a\n  - b\n1. c\n* d");
    expect(blocks).toMatchObject([
      { type: "bullet", indent: 0 },
      { type: "bullet", indent: 1 },
      { type: "bullet", indent: 0 },
      { type: "bullet", indent: 0 },
    ]);
  });

  it("collects a fenced code block with its language", () => {
    const blocks = parseMarkdown('```ts\nconst x = 1;\nconsole.log("hi");\n```\nafter');
    expect(blocks).toMatchObject([
      { type: "code", lang: "ts", lines: ["const x = 1;", 'console.log("hi");'] },
      { type: "paragraph" },
    ]);
  });

  it("keeps markdown syntax literal inside code fences", () => {
    const blocks = parseMarkdown("```\n# not a heading\n- not a bullet\n```");
    expect(blocks).toEqual([
      { type: "code", lang: "", lines: ["# not a heading", "- not a bullet"] },
    ]);
  });

  it("renders an unterminated fence as code (mid-stream safety)", () => {
    const blocks = parseMarkdown("```py\nprint(1)");
    expect(blocks).toEqual([{ type: "code", lang: "py", lines: ["print(1)"] }]);
  });

  it("parses blockquotes and blanks", () => {
    const blocks = parseMarkdown("> wise words\n\ntext");
    expect(blocks).toMatchObject([{ type: "quote" }, { type: "blank" }, { type: "paragraph" }]);
  });

  it("never throws on adversarial input", () => {
    const nasty = "``` \n``\n**\n*_`\n#\n>>>\n- \n```````";
    expect(() => parseMarkdown(nasty)).not.toThrow();
  });
});

describe("highlightCode", () => {
  const flat = (line: string) =>
    highlightCode(line)
      .map((s) => s.text)
      .join("");

  it("reassembles the exact source text", () => {
    const line = 'const x = "a b" + 42; // done';
    expect(flat(line)).toBe(line);
  });

  it("colors keywords, strings, numbers, and comments", () => {
    const spans = highlightCode('const s = "hi"; # note');
    expect(spans.find((s) => s.text === "const")?.color).toBe("magenta");
    expect(spans.find((s) => s.text === '"hi"')?.color).toBe("yellow");
    expect(spans.find((s) => s.text === "# note")?.color).toBe("gray");
    expect(highlightCode("x = 42").find((s) => s.text === "42")?.color).toBe("cyan");
  });

  it("leaves identifiers uncolored", () => {
    const spans = highlightCode("myVariable");
    expect(spans[0]?.color).toBeUndefined();
  });
});
