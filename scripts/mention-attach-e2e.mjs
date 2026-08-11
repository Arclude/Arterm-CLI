#!/usr/bin/env node
/**
 * Does `@` actually put a FILE in front of the model?
 *
 * The in-process test (`packages/tui/src/mention.test.tsx`) asserts the same
 * thing against a fake `Session`, and it is the faster loop. This exists for
 * what that one cannot see: the built single-file binary, a real terminal, and
 * the request body that leaves the process. Every layer between the keystroke
 * and the wire is a place where the block can be assembled correctly and then
 * dropped — and a dropped block is invisible, because the prompt still sends
 * and the model still answers, just without the file.
 *
 * Run it after a build:
 *
 *     pnpm -r build && node scripts/mention-attach-e2e.mjs
 *
 * The screen assertions matter as much as the wire ones. The picker takes ⇥⏎↑↓
 * away from the composer, and "the list is up" versus "the line was replaced by
 * a recalled prompt" is a distinction only a rendered frame can make.
 *
 * 9/9 after, **0/9** against the binary built one commit earlier. That second
 * number is the whole reason to keep the script: an assertion set that scores
 * well on a build without the feature is measuring the harness. The first draft
 * did exactly that — "a git-ignored file is not offered" passed 1/9 on the old
 * binary, because nothing is offered when there is no picker, so the check is
 * now anchored on a file that MUST appear beside the one that must not.
 */

import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BIN = join(import.meta.dirname, "..", "packages", "cli", "dist", "main.js");
const KEEP = process.env.KEEP_TRANSCRIPT === "1";
const FILE_TEXT = "the sky is teal";
/** One ↓, as the terminal sends it. */
const DOWN = "\u001b[B";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A fake OpenAI-compatible endpoint that records what it was sent. */
function fakeModel(bodies) {
  return createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
    });
    req.on("end", () => {
      if (req.url.includes("/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "fake" }] }));
        return;
      }
      bodies.push(raw);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "seen it" } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
}

/**
 * A HOME of our own, with the endpoint pinned in its config.
 *
 * Pinned per run because the CLI persists the whole config on exit: a stale
 * saved host silently redirects the next run away from the fake server, which
 * shows up as zero requests and an instant provider error.
 *
 * `tui.fullscreen` is pinned rather than left to the default, and it has to STAY
 * pinned: this script is the harness that caught the picker moving two rows per
 * ↓, and that double-step exists only in fullscreen, where arrows are read off
 * raw stdin as well as by Ink. Measured while the default was briefly classic —
 * every check below still passed there, so a flipped default would not have
 * failed anything; the coverage would simply have gone quiet.
 */
function sandbox(port) {
  const home = mkdtempSync(join(tmpdir(), "arterm-mention-home-"));
  mkdirSync(join(home, ".arterm"), { recursive: true });
  writeFileSync(
    join(home, ".arterm", "config.json"),
    JSON.stringify(
      {
        provider: "openai-compat",
        model: "fake",
        openaiCompatHost: `http://127.0.0.1:${port}/v1`,
        permissions: { mode: "auto" },
        tui: { fullscreen: true },
      },
      null,
      2,
    ),
  );
  return home;
}

/**
 * A git repo, because the picker's candidate set is `git ls-files` in one.
 *
 * More files than the box has rows, so the list is a WINDOW here rather than a
 * short list that happens to fit — the ninth match being unreachable is
 * invisible in a directory with three files. `git ls-files` sorts, and the
 * fillers are named to sort AFTER the two the rest of the script picks from, so
 * adding them does not push `notes.md` off the opening screen.
 */
const FILLERS = 12;
/** Candidates: `.gitignore`, `notes.md`, `other.ts`, then the fillers. */
const CANDIDATES = 3 + FILLERS;
/** Sorted ninth: three named files, then `zfill00`… — so index 8 is `zfill05`. */
const NINTH = "zfill05.ts";

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), "arterm-mention-work-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  writeFileSync(join(dir, "notes.md"), `${FILE_TEXT}\n`);
  writeFileSync(join(dir, "other.ts"), "export const x = 1;\n");
  writeFileSync(join(dir, ".gitignore"), "ignored.md\n");
  writeFileSync(join(dir, "ignored.md"), "not offered\n");
  for (let i = 0; i < FILLERS; i += 1) {
    writeFileSync(join(dir, `zfill${String(i).padStart(2, "0")}.ts`), "export const y = 1;\n");
  }
  return dir;
}

let failures = 0;
let total = 0;
function assert(ok, label, detail = "") {
  total += 1;
  console.log(`${ok ? "✓" : "✗"} ${label}${ok || !detail ? "" : `\n    ${detail}`}`);
  if (!ok) failures += 1;
}

async function main() {
  const bodies = [];
  const server = fakeModel(bodies);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const home = sandbox(port);
  const cwd = workspace();

  // A pty with a real size: with stdout redirected, `script`'s pty is 0x0 and
  // Ink renders a blank screen, which is indistinguishable from a hang.
  const child = spawn("script", ["-qec", `stty rows 45 cols 160; node ${BIN}`, "/dev/null"], {
    cwd,
    env: { ...process.env, HOME: home, NO_COLOR: "1" },
    stdio: ["pipe", "pipe", "inherit"],
  });

  let seen = "";
  child.stdout.on("data", (c) => {
    seen += c;
  });
  const waitFor = async (pred, what, timeout = 45_000) => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (pred(seen)) return true;
      await sleep(150);
    }
    console.log(`    (timed out waiting for ${what})`);
    return false;
  };

  try {
    await waitFor((f) => /›/.test(f), "the prompt");
    const before = seen.length;

    // Text and Enter must be SEPARATE writes: sent together they are detected
    // as a paste, and Enter inside a paste inserts a newline instead of
    // submitting.
    child.stdin.write("what colour @");
    assert(await waitFor((f) => f.includes("notes.md"), "the picker"), "the picker opens on @");
    const frame = seen.slice(before);
    assert(frame.includes("esc cancel"), "it says which keys apply while it is up");
    // Anchored on a POSITIVE: `ignored.md` is also absent from a screen with no
    // picker on it at all, so on its own this check passes against a build that
    // has none of this feature — which is the reading it exists to prevent.
    assert(
      frame.includes("other.ts") && !frame.includes("ignored.md"),
      "the list offers the tracked files and not the git-ignored one",
      "the candidate set is `git ls-files`, and the scope limit is the point",
    );

    // ── ↑↓, in the mode people actually run ──────────────────────────────────
    // A real pty means fullscreen, and fullscreen reads arrows off RAW stdin (to
    // tell a wheel tick from a keypress) while Ink parses the same bytes into
    // key events. One ↓ was therefore delivered to the picker twice and the
    // selection skipped a file — reported from a live session, and passing in
    // every in-process test, because those render the composer with fullscreen
    // off. The counter is the observable: `2/15` is index 1, `3/15` is the
    // second move nobody asked for.
    const navMark = seen.length;
    child.stdin.write(DOWN);
    assert(
      await waitFor((f) => f.slice(navMark).includes(`2/${CANDIDATES}`), "the second row"),
      "↓ steps to the next match",
    );
    // The router holds a lone arrow for 25 ms before ruling it a keypress, so a
    // second move lands AFTER this sleep — never before the wait above returns.
    await sleep(400);
    // Anchored on the positive, like the git-ignore check above it: "3/15 never
    // appeared" is also true of a build with no counter on screen at all, and a
    // check that passes against the binary without the fix is measuring the
    // harness. Against that binary this scored a vacuous ✓ before the `&&`.
    assert(
      seen.slice(navMark).includes(`2/${CANDIDATES}`) &&
        !seen.slice(navMark).includes(`3/${CANDIDATES}`),
      "…and only to the next one — one ↓ is one move",
      "a second listener answered the same keypress",
    );

    // ── the box is a window, not the end of the list ─────────────────────────
    const winMark = seen.length;
    for (let i = 0; i < 7; i += 1) {
      child.stdin.write(DOWN);
      await sleep(80);
    }
    const ninth = await waitFor(
      (f) => f.slice(winMark).includes(`9/${CANDIDATES}`),
      "the ninth match",
    );
    // Counted is not drawn: the box held eight rows while the selection walked
    // past them, so the ninth file was unreachable AND the highlight left the
    // screen. Asserting the marked ROW is what tells those apart.
    const markedRow = seen
      .slice(winMark)
      .split(/\r?\n/)
      .filter((l) => l.includes("▸"))
      .pop();
    assert(
      ninth && (markedRow ?? "").includes(NINTH),
      "the ninth match is DRAWN and selected, not just counted",
      `marked row was: ${JSON.stringify(markedRow ?? null)}`,
    );

    // Back to the top, so the rest of the run picks from a fresh query. The
    // narrowing has to be WAITED for against a fresh mark. Waiting for
    // "notes.md" would be vacuous — it is already on screen from the empty
    // query — so ⇥ fired before the list narrowed often enough to make this
    // script flap between 9/9 and 6/9, picking whichever row was first.
    const mark = seen.length;
    child.stdin.write("not");
    assert(
      await waitFor(
        (f) => f.slice(mark).includes("notes.md") && !f.slice(mark).includes("other.ts"),
        "the narrowed list",
      ),
      "typing narrows the list to the match",
    );

    child.stdin.write("\t");
    assert(
      await waitFor((f) => f.includes("@notes.md"), "the completed path"),
      "⇥ inserts the highlighted path",
    );

    child.stdin.write("\r");
    assert(
      await waitFor((f) => f.includes("attached —"), "the attach line"),
      "it says what it attached",
    );
    assert(await waitFor((f) => f.includes("seen it"), "the model's answer"), "the turn completes");
    await sleep(400);

    const messages = bodies
      .map((b) => {
        try {
          return JSON.parse(b);
        } catch {
          return {};
        }
      })
      .flatMap((b) => b.messages ?? []);
    const userText = messages
      .filter((m) => m.role === "user")
      .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
      .join("\n");

    // The one that matters. Everything above can be true while the model is
    // sent the bare line — that is the failure this script exists for.
    assert(
      userText.includes(FILE_TEXT),
      "the FILE'S CONTENTS reached the model",
      `user text was: ${userText.slice(0, 300)}`,
    );
    assert(userText.includes("what colour"), "the user's own sentence survived beside it");
    assert(
      userText.includes("@notes.md"),
      "the mention stayed in the sentence",
      "it is how you say WHICH file a question is about",
    );
  } finally {
    child.stdin.write("");
    child.kill();
    server.close();
    if (KEEP) console.log(`\n--- transcript ---\n${seen.slice(-4000)}`);
  }

  // Counted, never spelled: a hardcoded denominator drifts the moment an
  // assertion is added, and "8/8" for nine checks is a score nobody can read.
  console.log(`\n${total - failures}/${total} PASS`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
