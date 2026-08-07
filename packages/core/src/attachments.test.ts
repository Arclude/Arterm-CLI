import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MAX_IMAGE_FILE_BYTES,
  attachImageFiles,
  extractImagePaths,
  imageMediaType,
  readClipboardImage,
} from "./attachments.js";

/** A real 1×1 PNG — the magic check is the point, so a fake blob proves nothing. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), "arterm-attach-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const write = async (rel: string, body: Buffer | string) => {
  const abs = join(dir, rel);
  await fs.mkdir(join(abs, ".."), { recursive: true });
  await fs.writeFile(abs, body);
  return abs;
};

describe("extractImagePaths — a drag arrives as text", () => {
  it("finds a bare path", () => {
    expect(extractImagePaths("what is wrong in /home/t/shot.png ?")).toEqual(["/home/t/shot.png"]);
  });

  it("keeps a quoted path with a space in one piece", () => {
    // Splitting on whitespace tears "my shot.png" in half and finds neither.
    expect(extractImagePaths(`look at '/home/t/my shot.png' please`)).toEqual([
      "/home/t/my shot.png",
    ]);
    expect(extractImagePaths(`look at "/home/t/my shot.png"`)).toEqual(["/home/t/my shot.png"]);
  });

  it("understands a backslash-escaped space", () => {
    expect(extractImagePaths("/home/t/my\\ shot.png")).toEqual(["/home/t/my shot.png"]);
  });

  it("decodes a file:// URI, which is what some desktops drop", () => {
    expect(extractImagePaths("file:///home/t/my%20shot.png")).toEqual(["/home/t/my shot.png"]);
  });

  it("ignores anything that is not one of the four formats", () => {
    expect(extractImagePaths("read notes.txt and main.ts and shot.bmp")).toEqual([]);
  });

  it("names a file once however many times it appears", () => {
    expect(extractImagePaths("a.png then a.png again")).toEqual(["a.png"]);
  });

  it("finds several", () => {
    expect(extractImagePaths("compare a.png with b.jpeg")).toEqual(["a.png", "b.jpeg"]);
  });
});

describe("attachImageFiles", () => {
  it("attaches a real image as base64", async () => {
    await write("shot.png", PNG);
    const { attached, rejected } = await attachImageFiles(["shot.png"], dir);
    expect(rejected).toEqual([]);
    expect(attached).toHaveLength(1);
    expect(attached[0]?.image.mediaType).toBe("image/png");
    expect(attached[0]?.bytes).toBe(PNG.length);
    expect(Buffer.from(attached[0]?.image.data ?? "", "base64")).toEqual(PNG);
  });

  it("ACCEPTS a path outside the working directory", async () => {
    // The decision this file exists to record. A tool's path argument is model
    // output and is confined; this one was typed by the person at the keyboard,
    // and their screenshot lives in ~/Pictures, not in the repo. Confining it
    // would refuse the ordinary case and protect nobody.
    const outside = await fs.mkdtemp(join(tmpdir(), "arterm-elsewhere-"));
    try {
      await fs.writeFile(join(outside, "photo.png"), PNG);
      const { attached, rejected } = await attachImageFiles([join(outside, "photo.png")], dir);
      expect(rejected).toEqual([]);
      expect(attached).toHaveLength(1);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("refuses a .png whose bytes are not one, and names it", async () => {
    // The everyday cause is a download that returned an HTML error page. Sent
    // as an image it is a provider 400 that ends the turn saying nothing.
    await write("broken.png", "<html>404</html>");
    const { attached, rejected } = await attachImageFiles(["broken.png"], dir);
    expect(attached).toEqual([]);
    expect(rejected[0]).toContain("broken.png");
    expect(rejected[0]).toContain("bytes are not");
  });

  it("refuses a file over the size ceiling", async () => {
    const big = Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_FILE_BYTES)]);
    await write("huge.png", big);
    const { attached, rejected } = await attachImageFiles(["huge.png"], dir);
    expect(attached).toEqual([]);
    expect(rejected[0]).toContain("over the");
  });

  it("reports a path that does not exist rather than doing nothing", async () => {
    // The usual cause is a dragged path with a space that lost its quoting, and
    // "nothing happened" gives no way to find that out.
    const { rejected } = await attachImageFiles(["gone.png"], dir);
    expect(rejected[0]).toContain("gone.png");
    expect(rejected[0]).toContain("could not be read");
  });

  it("refuses a file that is not an image format at all", async () => {
    await write("notes.txt", "hello");
    const { rejected } = await attachImageFiles(["notes.txt"], dir);
    expect(rejected[0]).toContain("not a .png");
  });

  it("attaches the good ones and reports the bad ones from the same call", async () => {
    await write("ok.png", PNG);
    await write("bad.png", "nope");
    const { attached, rejected } = await attachImageFiles(["ok.png", "bad.png"], dir);
    expect(attached).toHaveLength(1);
    expect(rejected).toHaveLength(1);
  });
});

describe("imageMediaType", () => {
  it("maps the four formats a vision model accepts, case-insensitively", () => {
    expect(imageMediaType("a.PNG")).toBe("image/png");
    expect(imageMediaType("a.jpg")).toBe("image/jpeg");
    expect(imageMediaType("a.jpeg")).toBe("image/jpeg");
    expect(imageMediaType("a.gif")).toBe("image/gif");
    expect(imageMediaType("a.webp")).toBe("image/webp");
    expect(imageMediaType("a.bmp")).toBeUndefined();
  });
});

describe("readClipboardImage", () => {
  /** A stand-in reader: node writing chosen bytes to stdout, like wl-paste. */
  const reader = (script: string) => [
    { command: process.execPath, args: ["-e", script], install: "(the test)" },
  ];

  it("attaches what the reader printed", async () => {
    const { attachment, error } = await readClipboardImage(
      reader(
        `process.stdout.write(Buffer.from(${JSON.stringify(PNG.toString("base64"))},"base64"))`,
      ),
    );
    expect(error).toBeUndefined();
    expect(attachment?.image.mediaType).toBe("image/png");
    expect(attachment?.label).toBe("clipboard");
  });

  it("treats a clipboard holding text as ordinary, not as a broken image", async () => {
    const { attachment, error } = await readClipboardImage(
      reader(`process.stdout.write("just some copied text")`),
    );
    expect(attachment).toBeUndefined();
    expect(error).toContain("named as image/png but its bytes are not");
  });

  it("says what to install when no reader is present at all", async () => {
    const { error } = await readClipboardImage([
      { command: "arterm-no-such-clipboard-tool", args: [], install: "wl-clipboard" },
    ]);
    expect(error).toContain("No clipboard reader found");
    expect(error).toContain("wl-clipboard");
  });

  it("does not blame the toolchain when the reader is INSTALLED and the clipboard is text", async () => {
    // Found live, not here: on a real Wayland session with wl-clipboard
    // installed, copying text made `wl-paste --type image/png` exit non-zero,
    // and telling those apart by "did it produce bytes" reported "install
    // wl-clipboard" to someone who already had it. An error naming the wrong
    // cause is worse than no error.
    const { attachment, error } = await readClipboardImage([
      { command: process.execPath, args: ["-e", "process.exit(1)"], install: "wl-clipboard" },
    ]);
    expect(attachment).toBeUndefined();
    expect(error).toBe("No image on the clipboard.");
  });

  it("treats a reader that exits 0 with no output the same way", async () => {
    const { error } = await readClipboardImage([
      { command: process.execPath, args: ["-e", ""], install: "wl-clipboard" },
    ]);
    expect(error).toBe("No image on the clipboard.");
  });

  it("falls through a reader that exits non-zero to the next one", async () => {
    // The real shape of this: on a Wayland session xclip is installed and fails,
    // and picking one reader from $WAYLAND_DISPLAY would answer for the wrong
    // question — which display server runs, not which helper exists.
    const { attachment } = await readClipboardImage([
      { command: process.execPath, args: ["-e", "process.exit(1)"], install: "x" },
      ...reader(
        `process.stdout.write(Buffer.from(${JSON.stringify(PNG.toString("base64"))},"base64"))`,
      ),
    ]);
    expect(attachment?.image.mediaType).toBe("image/png");
  });
});
