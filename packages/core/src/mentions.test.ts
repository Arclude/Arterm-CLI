import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MAX_MENTION_BYTES,
  extractMentions,
  looksLikeText,
  mentionBlock,
  mentionSummary,
  readMentions,
} from "./mentions.js";

describe("extractMentions", () => {
  it("reads a path the user named", () => {
    expect(extractMentions("summarize @src/agent.ts please")).toEqual(["src/agent.ts"]);
  });

  it("takes an @ that opens the line", () => {
    expect(extractMentions("@README.md what is this")).toEqual(["README.md"]);
  });

  it("is NOT fooled by an email address", () => {
    // The single most common `@` in a sentence. Read as a mention it produces a
    // refusal line for a file nobody named, on a line that was about something
    // else entirely.
    expect(extractMentions("mail info@arclude.com about it")).toEqual([]);
  });

  it("is NOT fooled by an scp/ssh target", () => {
    expect(extractMentions("copy it to git@github.com:x/y.git")).toEqual([]);
  });

  it("drops the punctuation that ended the sentence, not the extension", () => {
    expect(extractMentions("look at @src/a.ts.")).toEqual(["src/a.ts"]);
    expect(extractMentions("(see @src/a.ts) later")).toEqual(["src/a.ts"]);
  });

  it("keeps a quoted path with a space whole", () => {
    expect(extractMentions('read @"my notes.md" now')).toEqual(["my notes.md"]);
  });

  it("reads several, once each", () => {
    expect(extractMentions("diff @a.ts against @b.ts and @a.ts")).toEqual(["a.ts", "b.ts"]);
  });
});

describe("looksLikeText", () => {
  it("accepts text with no extension to judge it by", () => {
    expect(looksLikeText(Buffer.from("FROM node:22\nRUN true\n"))).toBe(true);
  });

  it("refuses bytes with a NUL in them", () => {
    expect(looksLikeText(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01]))).toBe(false);
  });
});

describe("readMentions", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), "arterm-mentions-"));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("reads a file the user named", async () => {
    await fs.writeFile(join(dir, "a.ts"), "export const x = 1;\n");
    const res = await readMentions(["a.ts"], dir);
    expect(res.rejected).toEqual([]);
    expect(res.mentions[0]?.text).toContain("export const x = 1;");
    expect(res.mentions[0]?.clipped).toBe(false);
  });

  it("NAMES a file it could not read", async () => {
    // Silence here is the failure to prevent: it reads as "the model is looking
    // at it", which is the one wrong belief this must not leave anyone holding.
    const res = await readMentions(["nope.ts"], dir);
    expect(res.mentions).toEqual([]);
    expect(res.rejected[0]).toContain("nope.ts");
  });

  it("refuses a binary by name", async () => {
    await fs.writeFile(join(dir, "a.bin"), Buffer.from([0, 1, 2, 3]));
    const res = await readMentions(["a.bin"], dir);
    expect(res.mentions).toEqual([]);
    expect(res.rejected[0]).toContain("not a text file");
  });

  it("refuses a directory with advice rather than a stack trace", async () => {
    await fs.mkdir(join(dir, "sub"));
    const res = await readMentions(["sub"], dir);
    expect(res.rejected[0]).toContain("is a directory");
  });

  it("clips an over-large file and SAYS SO inside the text", async () => {
    // Stated, not silent. A model reading two thirds of a file while believing
    // it read all of it draws confident wrong conclusions, and the note is what
    // travels with the excerpt into the prompt.
    await fs.writeFile(join(dir, "big.txt"), "x".repeat(5000));
    const res = await readMentions(["big.txt"], dir, { perFile: 1000 });
    const m = res.mentions[0];
    expect(m?.clipped).toBe(true);
    expect(m?.text).toContain("omitted from the middle");
    expect(m?.bytes).toBe(5000);
  });

  it("stops at the total ceiling and names what it left out", async () => {
    await fs.writeFile(join(dir, "a.txt"), "a".repeat(800));
    await fs.writeFile(join(dir, "b.txt"), "b".repeat(800));
    const res = await readMentions(["a.txt", "b.txt"], dir, { perFile: 1000, total: 800 });
    expect(res.mentions).toHaveLength(1);
    expect(res.rejected[0]).toContain("b.txt");
  });

  it("reads one file once, however often it is named", async () => {
    await fs.writeFile(join(dir, "a.ts"), "x");
    const res = await readMentions(["a.ts", "./a.ts"], dir);
    expect(res.mentions).toHaveLength(1);
  });

  it("has a per-file ceiling in the hundreds of KB, not the tens of MB", () => {
    // The number is a SPEND limit — the block is re-sent on every iteration of
    // the turn — so a regression that relaxes it by an order of magnitude is a
    // billing change and should have to edit this line.
    expect(MAX_MENTION_BYTES).toBeLessThanOrEqual(256 * 1024);
  });
});

describe("mentionBlock", () => {
  it("returns nothing when nothing was read", () => {
    // Not an empty section: "the files you mentioned: (none)" reads as a failure
    // report for a line that mentioned nothing, which is most lines.
    expect(mentionBlock([])).toBe("");
  });

  it("fences each file under the name the user typed", () => {
    const block = mentionBlock([
      { label: "src/a.ts", path: "/x/src/a.ts", text: "const x = 1", bytes: 11, clipped: false },
    ]);
    expect(block).toContain("### src/a.ts");
    expect(block).toContain("```");
    expect(block).toContain("const x = 1");
  });

  it("says on the heading when a file is only an excerpt", () => {
    const block = mentionBlock([
      { label: "big.txt", path: "/x/big.txt", text: "…", bytes: 999_999, clipped: true },
    ]);
    expect(block).toContain("excerpt");
  });
});

describe("mentionSummary", () => {
  it("reports the count, the size and the names", () => {
    const line = mentionSummary([
      { label: "src/a.ts", path: "/x/src/a.ts", text: "", bytes: 2048, clipped: false },
    ]);
    expect(line).toContain("1 file");
    expect(line).toContain("2KB");
    expect(line).toContain("a.ts");
  });
});
