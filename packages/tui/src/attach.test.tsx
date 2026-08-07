import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus, type ImageContent, defaultConfig } from "@arterm/core";
import { render } from "ink-testing-library";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App } from "./App.js";
import { Item } from "./MessageList.js";
import type { DisplayItem, Session } from "./types.js";

/**
 * A photo the USER hands over — the direction the terminal makes awkward.
 *
 * Dragging a picture onto a terminal does not deliver the picture: it types the
 * PATH. So the drop the user performed arrives as text in the prompt, and the
 * only way to honour it is to read the line they submitted. This asserts the
 * whole way through — typed path to the images argument `Agent.run` receives —
 * because every intermediate step can look right while the model is shown
 * nothing, and that failure is silent by construction.
 */

const ENTER = "\r";
const tick = (ms = 20): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor(view: () => string, pred: (f: string) => boolean, timeout = 20_000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (pred(view())) return;
    await tick(20);
  }
  throw new Error(`condition not met within ${timeout}ms; last view:\n${view()}`);
}

/** A real 1×1 PNG: the magic-byte check is on this path, so a blob would fail. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

interface Seen {
  text: string;
  images?: ImageContent[];
}

function fakeSession(bus: EventBus, seen: Seen[]): Session {
  const noop = (): void => {};
  return {
    agent: {
      model: "qwen2.5:7b",
      effectiveContextWindow: () => 8192,
      reset: () => {},
      run: async (text: string, _signal?: AbortSignal, opts?: { images?: ImageContent[] }) => {
        seen.push({ text, ...(opts?.images ? { images: opts.images } : {}) });
        bus.emit({ type: "turn_start" });
        bus.emit({
          type: "assistant_message",
          message: { role: "assistant", content: "looked at it" },
        });
        bus.emit({ type: "turn_end" });
      },
    },
    bus,
    config: { ...defaultConfig() },
    providerLabel: "ollama",
    toolCount: 7,
    yolo: false,
    setAsker: noop,
    listModels: async () => [],
    listAllModels: async () => [],
    switchModel: noop,
    switchProvider: noop,
    setApiKey: noop,
    configureOpenAICompat: async () => {},
    removeApiKey: noop,
    signedInProviders: () => [],
    loginProviders: [],
    compact: async () => ({}) as never,
    permissionMode: "auto",
    setMode: noop,
    autonomy: {
      state: "idle",
      start: async () => {},
      pause: noop,
      resume: noop,
      stop: noop,
      steer: noop,
      setMode: () => true,
    },
    sdd: { state: "idle", run: async () => {}, pause: noop, resume: noop, stop: noop },
    mcpServers: [],
    plugins: [],
    skills: [],
    getSkillBody: () => undefined,
  } as unknown as Session;
}

let dir: string;
let cwd: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), "arterm-drag-"));
  // The submit path resolves a relative path against process.cwd(), the same
  // directory the status bar names.
  cwd = process.cwd();
  process.chdir(dir);
});
afterEach(async () => {
  process.chdir(cwd);
  await fs.rm(dir, { recursive: true, force: true });
});

describe("a photo dragged onto the prompt reaches the model", () => {
  it("attaches the image the submitted line names", async () => {
    await fs.writeFile(join(dir, "shot.png"), PNG);
    const seen: Seen[] = [];
    const bus = new EventBus();
    const { stdin, frames, unmount } = render(
      createElement(App, { session: fakeSession(bus, seen) }),
    );
    const latest = () => frames[frames.length - 1] ?? "";

    // Wait for the composer to exist before typing at it — a fixed tick here is
    // what made the queue test fail two runs in three.
    await waitFor(latest, (f) => f.includes("message…"));
    const line = "what is wrong in shot.png ?";
    stdin.write(line);
    await waitFor(latest, (f) => f.includes("shot.png"));
    stdin.write(ENTER);

    await waitFor(
      () => JSON.stringify(seen),
      () => seen.length > 0,
    );
    expect(seen[0]?.text).toBe(line);
    expect(seen[0]?.images).toHaveLength(1);
    expect(seen[0]?.images?.[0]?.mediaType).toBe("image/png");
    // The bytes, not just the shape: a truncated or re-encoded attachment is a
    // provider 400 that ends the turn.
    expect(Buffer.from(seen[0]?.images?.[0]?.data ?? "", "base64")).toEqual(PNG);

    unmount();
  }, 30_000);

  it("sends the sentence unchanged — the path is the user's own words", async () => {
    // Silently editing a person's prompt is worse than a duplicated path, and
    // the path names what they are asking about.
    await fs.writeFile(join(dir, "a.png"), PNG);
    const seen: Seen[] = [];
    const { stdin, frames, unmount } = render(
      createElement(App, { session: fakeSession(new EventBus(), seen) }),
    );
    const latest = () => frames[frames.length - 1] ?? "";
    await waitFor(latest, (f) => f.includes("message…"));
    stdin.write("a.png");
    await waitFor(latest, (f) => f.includes("a.png"));
    stdin.write(ENTER);

    await waitFor(
      () => JSON.stringify(seen),
      () => seen.length > 0,
    );
    expect(seen[0]?.text).toBe("a.png");
    unmount();
  }, 30_000);

  it("says so when the named file is not an image it can send", async () => {
    // The refusal has to be visible: silence reads as "the model is looking at
    // it", which is the one wrong belief to leave the user holding.
    await fs.writeFile(join(dir, "broken.png"), "<html>404</html>");
    const seen: Seen[] = [];
    const { stdin, frames, unmount } = render(
      createElement(App, { session: fakeSession(new EventBus(), seen) }),
    );
    const latest = () => frames[frames.length - 1] ?? "";
    const seenAll = () => frames.join("\n");
    await waitFor(latest, (f) => f.includes("message…"));
    stdin.write("look at broken.png");
    await waitFor(latest, (f) => f.includes("broken.png"));
    stdin.write(ENTER);

    await waitFor(seenAll, (f) => f.includes("not attached"));
    expect(seen[0]?.images).toBeUndefined();
    unmount();
  }, 30_000);

  it("sends nothing extra for a turn that named no image", async () => {
    const seen: Seen[] = [];
    const { stdin, frames, unmount } = render(
      createElement(App, { session: fakeSession(new EventBus(), seen) }),
    );
    const latest = () => frames[frames.length - 1] ?? "";
    await waitFor(latest, (f) => f.includes("message…"));
    stdin.write("hello");
    await waitFor(latest, (f) => f.includes("hello"));
    stdin.write(ENTER);

    await waitFor(
      () => JSON.stringify(seen),
      () => seen.length > 0,
    );
    expect(seen[0]?.images).toBeUndefined();
    unmount();
  }, 30_000);
});

describe("Ctrl+V puts a token in the LINE, and deleting it takes the image back", () => {
  /**
   * The clipboard is stubbed through ARTERM_CLIPBOARD_CMD — a real escape
   * hatch, not a test-only hook: it is how someone on a setup none of the
   * built-in readers fit points us at their own tool.
   */
  let script: string;
  beforeEach(async () => {
    script = join(dir, "fake-paste.sh");
    await fs.writeFile(script, `#!/bin/sh\ncat ${JSON.stringify(join(dir, "clip.png"))}\n`);
    await fs.chmod(script, 0o755);
    await fs.writeFile(join(dir, "clip.png"), PNG);
    process.env.ARTERM_CLIPBOARD_CMD = script;
  });
  afterEach(() => {
    process.env.ARTERM_CLIPBOARD_CMD = undefined;
  });

  const CTRL_V = "\x16";

  it("shows [Image #1] in the prompt and sends the image with it", async () => {
    const seen: Seen[] = [];
    const { stdin, frames, unmount } = render(
      createElement(App, { session: fakeSession(new EventBus(), seen) }),
    );
    const latest = () => frames[frames.length - 1] ?? "";
    await waitFor(latest, (f) => f.includes("message…"));

    stdin.write("bunda ne var? ");
    await waitFor(latest, (f) => f.includes("bunda ne var?"));
    stdin.write(CTRL_V);
    // The token in the line is the WHOLE of what a terminal can show for a
    // picture — without it the only evidence Ctrl+V did anything is a chip.
    await waitFor(latest, (f) => f.includes("[Image #1]"));
    // And the rail prices it. Asserted because the first version of this
    // handler called setInput from INSIDE the setAttachments updater: the
    // token appeared, the image reached the model, and the chip never
    // rendered — an impure updater React is free to run twice or mid-render.
    expect(latest()).toContain("attached");
    stdin.write(ENTER);

    await waitFor(
      () => JSON.stringify(seen),
      () => seen.length > 0,
    );
    expect(seen[0]?.text).toContain("[Image #1]");
    expect(seen[0]?.images).toHaveLength(1);
    expect(Buffer.from(seen[0]?.images?.[0]?.data ?? "", "base64")).toEqual(PNG);
    unmount();
  }, 30_000);

  it("backspacing the token off sends no image", async () => {
    const seen: Seen[] = [];
    const { stdin, frames, unmount } = render(
      createElement(App, { session: fakeSession(new EventBus(), seen) }),
    );
    const latest = () => frames[frames.length - 1] ?? "";
    await waitFor(latest, (f) => f.includes("message…"));

    stdin.write("hmm");
    await waitFor(latest, (f) => f.includes("hmm"));
    stdin.write(CTRL_V);
    await waitFor(latest, (f) => f.includes("[Image #1]"));
    // One backspace, not ten: the token is one thing.
    stdin.write("\x7f");
    await waitFor(latest, (f) => !f.includes("[Image #1]"));
    stdin.write(ENTER);

    await waitFor(
      () => JSON.stringify(seen),
      () => seen.length > 0,
    );
    expect(seen[0]?.images).toBeUndefined();
    unmount();
  }, 30_000);

  it("numbers a second paste, and keeps both", async () => {
    const seen: Seen[] = [];
    const { stdin, frames, unmount } = render(
      createElement(App, { session: fakeSession(new EventBus(), seen) }),
    );
    const latest = () => frames[frames.length - 1] ?? "";
    await waitFor(latest, (f) => f.includes("message…"));

    stdin.write(CTRL_V);
    await waitFor(latest, (f) => f.includes("[Image #1]"));
    stdin.write(CTRL_V);
    await waitFor(latest, (f) => f.includes("[Image #2]"));
    stdin.write(ENTER);

    await waitFor(
      () => JSON.stringify(seen),
      () => seen.length > 0,
    );
    expect(seen[0]?.images).toHaveLength(2);
    unmount();
  }, 30_000);
});

describe("what was attached is visible on the user's own row", () => {
  const frame = (node: Parameters<typeof render>[0]): string => {
    const { lastFrame, unmount } = render(node);
    const out = lastFrame() ?? "";
    unmount();
    return out;
  };

  it("marks the image and prices it", () => {
    const item: DisplayItem = {
      kind: "user",
      text: "what is wrong here?",
      images: { count: 1, bytes: 245_000 },
    };
    const out = frame(createElement(Item, { item }));
    expect(out).toMatch(/▨|i /);
    expect(out).toMatch(/2\d\d\s?KB|239KB/i);
    expect(out).toContain("attached");
  });

  it("counts more than one", () => {
    const item: DisplayItem = {
      kind: "user",
      text: "compare these",
      images: { count: 3, bytes: 600_000 },
    };
    expect(frame(createElement(Item, { item }))).toContain("×3");
  });

  it("says nothing on an ordinary turn", () => {
    const item: DisplayItem = { kind: "user", text: "hello" };
    const out = frame(createElement(Item, { item }));
    expect(out).not.toContain("attached");
    expect(out).not.toContain("▨");
  });
});
