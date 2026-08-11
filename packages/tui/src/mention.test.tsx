import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus, defaultConfig } from "@arterm/core";
import { render } from "ink-testing-library";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App } from "./App.js";
import type { Session } from "./types.js";

/**
 * `@` attaches a file, all the way through.
 *
 * The unit halves — `mentionInput.ts` for what the keys mean, `mentions.ts` for
 * what a path resolves to — both pass while the SEAM between them is dead, and
 * the seam is the whole feature: a picker that opens and inserts a path but
 * never reaches `Agent.run` looks completely correct on screen. That is this
 * repo's most expensive failure shape (see CLAUDE.md on the ledger's `ctx.tool`
 * gate, and the witness list that was only ever proven empty), so the assertion
 * that matters is the last one: the model was sent the file's CONTENTS.
 *
 * ↑↓ are asserted too, because the picker is the first thing here to take them
 * from prompt history — Ink runs every mounted handler for one keypress, so
 * "the picker moved" and "the line was replaced by an old prompt" are things
 * that can both happen to the same arrow.
 */

const ENTER = "\r";
const TAB = "\t";
const UP = "\u001B[A";
const DOWN = "\u001B[B";
const ESC = "\u001B";
const tick = (ms = 20): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor(view: () => string, pred: (f: string) => boolean, timeout = 20_000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (pred(view())) return;
    await tick(20);
  }
  throw new Error(`condition not met within ${timeout}ms; last view:\n${view()}`);
}

function fakeSession(bus: EventBus, seen: string[]): Session {
  const noop = (): void => {};
  return {
    agent: {
      model: "qwen2.5:7b",
      effectiveContextWindow: () => 8192,
      interject: () => {},
      takeInterjections: () => [],
      reset: () => {},
      run: async (text: string) => {
        seen.push(text);
        bus.emit({ type: "turn_start" });
        bus.emit({
          type: "assistant_message",
          message: { role: "assistant", content: "read it" },
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
  dir = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "arterm-mention-")));
  cwd = process.cwd();
  process.chdir(dir);
});
afterEach(async () => {
  process.chdir(cwd);
  // Retried, because the picker's candidate list spawns `git ls-files` with
  // this directory as its cwd, and on Windows a child process holding a cwd
  // keeps it locked until it exits — `rmdir` there fails EBUSY on a test that
  // passed. Cleanup is not what any of this is about, so it does not get to
  // fail the suite.
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/**
 * Renders App over the temp cwd and waits for the composer to exist.
 *
 * `fullscreen` is a parameter because it is the mode every real session runs in
 * (`tui.fullscreen` defaults true on a TTY) and the one this file used to leave
 * untested — App reads arrows off RAW stdin there, in addition to the parsed
 * key events, so a picker can navigate correctly in the mode the tests drive
 * and move two rows per press in the mode people use.
 */
async function mounted(seen: string[], opts: { fullscreen?: boolean } = {}) {
  const bus = new EventBus();
  const view = render(
    createElement(App, { session: fakeSession(bus, seen), fullscreen: opts.fullscreen ?? false }),
  );
  const latest = () => view.frames[view.frames.length - 1] ?? "";
  await waitFor(latest, (f) => f.includes("message…"));
  return { ...view, latest };
}

describe("the @ picker", () => {
  it("opens on @ and lists the files in this directory", async () => {
    await fs.writeFile(join(dir, "notes.md"), "hello");
    const { stdin, latest, unmount } = await mounted([]);

    stdin.write("read @");
    await waitFor(latest, (f) => f.includes("notes.md"));
    expect(latest()).toContain("attach");
    unmount();
  }, 30_000);

  it("narrows as the query is typed, and says how many there are", async () => {
    for (let i = 0; i < 12; i += 1) await fs.writeFile(join(dir, `alpha${i}.ts`), "x");
    await fs.writeFile(join(dir, "beta.ts"), "x");
    const { stdin, latest, unmount } = await mounted([]);

    stdin.write("read @");
    // Thirteen matches in an eight-row box: the count is what says the box is a
    // window onto a longer list rather than the end of one.
    await waitFor(latest, (f) => f.includes("1/13"));
    stdin.write("beta");
    await waitFor(latest, (f) => f.includes("1/1 ·"));
    expect(latest()).not.toContain("alpha0.ts");
    unmount();
  }, 30_000);

  it("scrolls to a match the box cannot draw, instead of ending at eight", async () => {
    // The complaint this was written for: with nine files the ninth was
    // unreachable and the highlight walked off the top of a list that still
    // looked complete. Asserted structurally rather than by filename, because
    // the candidate walk does not promise an order.
    for (let i = 0; i < 13; i += 1) await fs.writeFile(join(dir, `alpha${i}.ts`), "x");
    const { stdin, latest, unmount } = await mounted([]);

    stdin.write("read @alpha");
    await waitFor(latest, (f) => f.includes("1/13"));
    const drawn = (): Set<string> => new Set(latest().match(/alpha\d+\.ts/g) ?? []);
    const before = drawn();
    expect(before.size).toBe(8);

    for (let i = 0; i < 8; i += 1) stdin.write(DOWN);
    await waitFor(latest, (f) => f.includes("9/13"));
    const picked = (
      latest()
        .split("\n")
        .find((l) => l.includes("▸")) ?? ""
    ).match(/alpha\d+\.ts/)?.[0];
    expect(picked).toBeDefined();
    // The ninth match is a row the box could not draw when it opened, and it is
    // both on screen and selected now.
    expect(before.has(picked as string)).toBe(false);
    unmount();
  }, 30_000);

  it("moves ONE row per ↓ in fullscreen, where two listeners hear the same key", async () => {
    // Fullscreen reads arrows off raw stdin (to tell a wheel tick from a
    // keypress) while `useInput` parses the SAME emitter — so one ↓ reached the
    // picker twice and the selection skipped a file. The bug is invisible to
    // every other test here: they render App with fullscreen off.
    for (let i = 0; i < 6; i += 1) await fs.writeFile(join(dir, `alpha${i}.ts`), "x");
    const { stdin, latest, unmount } = await mounted([], { fullscreen: true });

    stdin.write("read @alpha");
    await waitFor(latest, (f) => f.includes("1/6"));
    stdin.write(DOWN);
    await waitFor(latest, (f) => f.includes("2/6"));
    // The router holds a lone arrow for 25 ms before ruling it a keypress, so a
    // second move arrives AFTER the wait above — never before it.
    await tick(150);
    expect(latest()).toContain("2/6");
    unmount();
  }, 30_000);

  it("inserts the highlighted path on ⇥ and closes", async () => {
    await fs.writeFile(join(dir, "notes.md"), "hello");
    const { stdin, latest, unmount } = await mounted([]);

    stdin.write("read @not");
    await waitFor(latest, (f) => f.includes("notes.md"));
    stdin.write(TAB);
    await waitFor(latest, (f) => f.includes("read @notes.md"));
    // Closed: the hint line goes with the list.
    expect(latest()).not.toContain("esc cancel");
    unmount();
  }, 30_000);

  it("steps the highlight with ↑↓ instead of recalling history", async () => {
    // The picker is the first thing here to take ↑↓ from prompt history, and
    // Ink runs every mounted handler for one keypress — so this asserts BOTH
    // halves: the selection moved, and the line was not overwritten by the
    // recalled prompt. With no history at all the second half is vacuous, which
    // is why a prompt is submitted first.
    await fs.writeFile(join(dir, "one.ts"), "x");
    await fs.writeFile(join(dir, "two.ts"), "x");
    await fs.writeFile(join(dir, "three.ts"), "x");
    const seen: string[] = [];
    const { stdin, latest, unmount } = await mounted(seen);

    stdin.write("an earlier prompt");
    await waitFor(latest, (f) => f.includes("an earlier prompt"));
    stdin.write(ENTER);
    await waitFor(
      () => JSON.stringify(seen),
      () => seen.length > 0,
    );

    stdin.write("read @");
    await waitFor(latest, (f) => f.includes("one.ts") && f.includes("two.ts"));
    const marked = () =>
      latest()
        .split("\n")
        .find((l) => l.includes("▸"))
        ?.trim();
    const first = marked();
    expect(first).toBeDefined();

    stdin.write(DOWN);
    await waitFor(latest, () => marked() !== first);
    const second = marked();
    // The line is untouched: ↓ moved a highlight, it did not recall anything.
    expect(latest()).toContain("read @");
    expect(latest()).not.toContain("an earlier prompt ");

    stdin.write(UP);
    await waitFor(latest, () => marked() === first);
    expect(marked()).not.toBe(second);
    expect(latest()).toContain("read @");
    unmount();
  }, 30_000);

  it("closes on Esc and STAYS closed for that mention", async () => {
    // A boolean flag would be cleared by the next keystroke, and the list
    // someone just dismissed would spring back mid-word.
    await fs.writeFile(join(dir, "notes.md"), "hello");
    const { stdin, latest, unmount } = await mounted([]);

    stdin.write("read @not");
    await waitFor(latest, (f) => f.includes("notes.md"));
    stdin.write(ESC);
    await waitFor(latest, (f) => !f.includes("esc cancel"));
    stdin.write("e");
    await tick(80);
    expect(latest()).not.toContain("esc cancel");
    // …and the next mention opens normally.
    stdin.write(" @not");
    await waitFor(latest, (f) => f.includes("esc cancel"));
    unmount();
  }, 30_000);

  it("does not open on an email address", async () => {
    await fs.writeFile(join(dir, "notes.md"), "hello");
    const { stdin, latest, unmount } = await mounted([]);

    stdin.write("mail info@arclude");
    await tick(120);
    expect(latest()).not.toContain("esc cancel");
    unmount();
  }, 30_000);
});

describe("what the model is actually sent", () => {
  it("carries the file's CONTENTS, not just its path", async () => {
    // The assertion the whole feature rests on. Every step before this one can
    // look right on screen while the model receives the bare line.
    await fs.writeFile(join(dir, "notes.md"), "the sky is teal");
    const seen: string[] = [];
    const { stdin, latest, unmount } = await mounted(seen);

    stdin.write("what colour @not");
    await waitFor(latest, (f) => f.includes("notes.md"));
    stdin.write(TAB);
    // Deliberately NO settle tick: ⇥⏎ in one burst is what a fast typist sends,
    // and it used to lose the Enter to two handlers reading a stale render.
    stdin.write(ENTER);

    await waitFor(
      () => JSON.stringify(seen),
      () => seen.length > 0,
    );
    const sent = seen[0] ?? "";
    expect(sent).toContain("the sky is teal");
    // The user's own words survive alongside it: the mention says WHICH file the
    // sentence is about, so removing it would take the sentence with it.
    expect(sent).toContain("what colour");
    expect(sent).toContain("@notes.md");
    unmount();
  }, 30_000);

  it("says on screen what it attached and how big it was", async () => {
    await fs.writeFile(join(dir, "notes.md"), "x".repeat(2048));
    const seen: string[] = [];
    const { stdin, latest, unmount } = await mounted(seen);

    // The trailing space closes the picker, which is what a typed-in-full path
    // looks like: no row is being taken, so ⏎ means send.
    stdin.write("read @notes.md ");
    await tick(80);
    stdin.write(ENTER);
    await waitFor(latest, (f) => f.includes("attached —"));
    expect(latest()).toContain("2KB");
    unmount();
  }, 30_000);

  it("NAMES a file it could not read rather than sending the line silently", async () => {
    const seen: string[] = [];
    const { stdin, latest, unmount } = await mounted(seen);

    // No candidate matches, so the list is up saying so — and ⏎ still SENDS.
    // Owning the key with nothing to pick would make a path the list does not
    // offer (an ignored file, an absolute path) impossible to submit at all.
    stdin.write("read @missing.md");
    await waitFor(latest, (f) => f.includes("no file matches"));
    stdin.write(ENTER);
    await waitFor(latest, (f) => f.includes("not attached"));
    expect(latest()).toContain("missing.md");
    // The turn still runs — a bad mention is not a reason to swallow the prompt.
    await waitFor(
      () => JSON.stringify(seen),
      () => seen.length > 0,
    );
    unmount();
  }, 30_000);
});
