import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_IMAGE_BYTES } from "@arterm/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readTool } from "./read.js";

/**
 * `read` on an image file. The behavior being pinned is that an image stops
 * being "a binary file, not decoding it" — while an actual binary still is.
 */

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const GIF_MAGIC = Buffer.from("GIF89a", "latin1");

let dir: string;
beforeEach(async () => {
  dir = join(tmpdir(), `arterm-read-img-${Math.random().toString(36).slice(2)}`);
  await fs.mkdir(dir, { recursive: true });
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function write(name: string, bytes: Buffer): Promise<string> {
  const path = join(dir, name);
  await fs.writeFile(path, bytes);
  return path;
}

describe("read on image files", () => {
  it("returns a PNG as image content instead of refusing it as binary", async () => {
    const body = Buffer.concat([PNG_MAGIC, Buffer.from("payload")]);
    const path = await write("shot.png", body);
    const res = await readTool.execute({ path }, { cwd: dir });

    expect(res.isError).toBeFalsy();
    expect(res.images).toHaveLength(1);
    expect(res.images?.[0]?.mediaType).toBe("image/png");
    expect(res.images?.[0]?.data).toBe(body.toString("base64"));
    // The text still says something usable — a bare image leaves the model
    // nothing to quote when it reports what it looked at.
    expect(res.output).toContain("image/png");
    expect(res.output).toContain(String(body.length));
  });

  it("maps the extension to its media type, case-insensitively", async () => {
    const path = await write("anim.GIF", GIF_MAGIC);
    const res = await readTool.execute({ path }, { cwd: dir });
    expect(res.images?.[0]?.mediaType).toBe("image/gif");
  });

  it("refuses a file whose bytes are not the format its name claims", async () => {
    // The routine failure: a download saved as .png that is really an error page.
    const path = await write("broken.png", Buffer.from("<html>404</html>"));
    const res = await readTool.execute({ path }, { cwd: dir });

    expect(res.isError).toBe(true);
    expect(res.images).toBeUndefined();
    expect(res.output).toContain("its bytes are not");
  });

  it("refuses an image too large to inline, naming the file's own size", async () => {
    const raw = Math.floor((MAX_IMAGE_BYTES * 3) / 4) + 1;
    const body = Buffer.concat([PNG_MAGIC, Buffer.alloc(raw - PNG_MAGIC.length, 0x41)]);
    const path = await write("huge.png", body);
    const res = await readTool.execute({ path }, { cwd: dir });

    expect(res.isError).toBe(true);
    expect(res.images).toBeUndefined();
    expect(res.output).toContain(String(raw));
  });

  it("still refuses a genuine binary that is not an image", async () => {
    const path = await write("a.bin", Buffer.from([0, 1, 2, 3, 0, 0, 0, 0]));
    const res = await readTool.execute({ path }, { cwd: dir });

    expect(res.isError).toBe(true);
    expect(res.output).toContain("looks like a binary file");
    expect(res.images).toBeUndefined();
  });

  it("reads a text file exactly as before", async () => {
    const path = await write("a.ts", Buffer.from("const a = 1;\nconst b = 2;\n"));
    const res = await readTool.execute({ path }, { cwd: dir });

    expect(res.images).toBeUndefined();
    expect(res.output).toContain("const a = 1;");
    expect(res.output).toContain("    1\t");
  });
});
