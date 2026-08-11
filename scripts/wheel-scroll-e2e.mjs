#!/usr/bin/env node
/**
 * Who owns the mouse wheel — and can a wheel tick still type?
 *
 * The reported bug was one sentence with two halves: "scrolling the chat is
 * jerky, and scrolling still brings prompts back from history". Both come from
 * the same mechanism. The alternate screen has no scrollback for the wheel to
 * move, so the app asked the terminal to translate wheel ticks into ARROW KEYS
 * (alternate scroll, DECSET 1007) and read the chat's scroll back out of them.
 * A tick expands to three arrows, which is where the three-line jumps came
 * from — and a terminal configured for one line per tick sends exactly one
 * arrow, byte-identical to a human pressing ↑. Nothing downstream can separate
 * those, so scrolling recalled prompts.
 *
 * The fix is to change the CHANNEL, not to guess better. With SGR mouse
 * reporting (?1000h + ?1006h) a tick arrives as `ESC[<64;x;yM`, where the
 * direction is in the bytes and no keypress can spell it. ?1007 is never
 * enabled again. That is also what Claude Code does, measured off its own wire:
 * ?1049h then ?1000h ?1002h ?1003h ?1006h at boot, re-asserted mid-run, and
 * ?1007 nowhere in the stream.
 *
 * This script is what makes that a fact about the BUILT binary rather than a
 * claim about a default value — the modes are escape sequences on a pty, which
 * no in-process test can see.
 *
 * Run it after a build:
 *
 *     pnpm -r build && node scripts/wheel-scroll-e2e.mjs
 *
 * Every check is anchored on a positive. "The wheel did not recall a prompt" is
 * equally true of a process that crashed on startup, so the same tick must be
 * shown to SCROLL, and a real ↑ must still recall. The earlier version of this
 * script could only assert the negatives — under alternate scroll a tick and a
 * keypress are the same bytes, so no assertion could tell them apart — and that
 * limit is gone with the mechanism: the two are now different sequences, so the
 * case as REPORTED is finally reproducible here.
 *
 * 18/18 after, **10/18** against the binary built one commit earlier — and the
 * gap between those numbers is the anchor lesson itself. Two of the pre-fix ten
 * are vacuous passes: "does NOT recall the last prompt" and "scrolling back
 * down reaches the newest output" are both trivially true of a build that
 * ignored the tick entirely. What separates the builds is the POSITIVE they
 * hang off — "a wheel tick SCROLLS the transcript" — which is the check that
 * fails there. A negative without its anchor measures the harness.
 *
 * Section 4 asks a different question of the same wire: does a KILLED session
 * give the terminal back? Ink's teardown never runs for a signal, so capture
 * left enabled makes the user's shell print a mouse report on every click for
 * the rest of its life. Those three checks fail against the earlier binary too.
 */

import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BIN = join(import.meta.dirname, "..", "packages", "cli", "dist", "main.js");
const ESC = String.fromCharCode(27);
const UP = `${ESC}[A`;
/** One wheel tick as a CAPTURED mouse sends it: button 64 = up, 65 = down. */
const WHEEL_UP = `${ESC}[<64;10;10M`;
const WHEEL_DOWN = `${ESC}[<65;10;10M`;
/** Colour codes and cursor moves — stripped before any TEXT is matched. */
const ANSI = new RegExp(`${ESC}\\[[0-9;?<]*[a-zA-Z]`, "g");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A fake OpenAI-compatible endpoint; the answer is long enough to overflow. */
function fakeModel() {
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
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (let i = 0; i < 60; i += 1) {
        res.write(
          `data: ${JSON.stringify({ choices: [{ delta: { content: `satir ${i}\n` } }] })}\n\n`,
        );
      }
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
}

/**
 * A HOME of our own, with the endpoint pinned in its config.
 *
 * `tui` is written only when the caller asks for it: most checks here are about
 * what an UNTOUCHED config does, and a config that names the mode would be
 * testing the config file instead of the default.
 */
function sandboxHome(port, tui) {
  const home = mkdtempSync(join(tmpdir(), "arterm-wheel-home-"));
  mkdirSync(join(home, ".arterm"), { recursive: true });
  writeFileSync(
    join(home, ".arterm", "config.json"),
    JSON.stringify(
      {
        provider: "openai-compat",
        model: "fake",
        openaiCompatHost: `http://127.0.0.1:${port}/v1`,
        permissions: { mode: "auto" },
        sandbox: { enabled: false },
        ...(tui ? { tui } : {}),
      },
      null,
      2,
    ),
  );
  return home;
}

let failures = 0;
let total = 0;
function assert(ok, label, detail = "") {
  total += 1;
  console.log(`${ok ? "✓" : "✗"} ${label}${ok || !detail ? "" : `\n    ${detail}`}`);
  if (!ok) failures += 1;
}

function launch(home) {
  const cwd = mkdtempSync(join(tmpdir(), "arterm-wheel-work-"));
  // A pty with a real size: with stdout redirected, `script`'s pty is 0x0 and
  // Ink renders a blank screen, which is indistinguishable from a hang.
  const child = spawn("script", ["-qec", `stty rows 40 cols 120; node ${BIN}`, "/dev/null"], {
    cwd,
    env: { ...process.env, HOME: home, NO_COLOR: "1" },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const state = { seen: "" };
  child.stdout.on("data", (c) => {
    state.seen += c;
  });
  // Two views of the same stream, and mixing them up is how this script nearly
  // shipped a vacuous pass. The MODE checks need the raw bytes — an escape
  // sequence is the thing being asserted. The TEXT checks must not see them:
  // Ink colours the composer, so the raw stream holds `›`, a colour reset and
  // then the prompt, and `includes("› birinci soru")` is false on a screen that
  // is displaying exactly that. Asserted as a negative ("the wheel did not
  // recall it") that reads as a pass no matter what the app did.
  const text = () => state.seen.replace(ANSI, "");
  // The CURRENT screen, not everything ever printed.
  //
  // The scroll indicator is a row that appears and disappears, and a question
  // like "is the view back at the bottom?" is about the latest frame only —
  // asked of the accumulated stream it can never be true again, because the
  // frames drawn while scrolling are still in the buffer. That is not a
  // hypothetical: the first version of this script asserted on the accumulated
  // tail and passed, but only because the six ticks arrived as ONE chunk and
  // the whole scroll therefore happened in a single frame. Spacing the ticks
  // like a real wheel turned it into a permanent failure against a build that
  // was working correctly.
  //
  // The indicator sits immediately ABOVE the composer box, whose top border is
  // redrawn every repaint — so anchor there and read backwards.
  const nearPrompt = () => {
    const t = text();
    const i = t.lastIndexOf("╭─◆ ARTERM");
    return i < 0 ? "" : t.slice(Math.max(0, i - 160), i);
  };
  const waitFor = async (pred, what, timeout = 45_000) => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (pred(text())) return true;
      await sleep(120);
    }
    console.log(`    (timed out waiting for ${what})`);
    return false;
  };
  return { child, state, text, nearPrompt, waitFor };
}

/**
 * The pid of the actual TUI, not of `script`.
 *
 * `script -qec` runs the command through a shell, so the node process is a
 * GRANDCHILD — signalling `child.pid` kills the pty wrapper and proves nothing
 * about what the TUI does on its way out. Walks the process tree instead of
 * matching on the binary path, because several of these run at once.
 */
function tuiPid(rootPid) {
  const kids = (pid) => {
    try {
      return execFileSync("pgrep", ["-P", String(pid)], { encoding: "utf8" })
        .split("\n")
        .filter(Boolean)
        .map(Number);
    } catch {
      return [];
    }
  };
  const queue = [...kids(rootPid)];
  while (queue.length > 0) {
    const pid = queue.shift();
    let cmd = "";
    try {
      cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8");
    } catch {
      continue;
    }
    if (cmd.includes("dist/main.js")) return pid;
    queue.push(...kids(pid));
  }
  return null;
}

async function main() {
  const server = fakeModel();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;

  // ── 1. What an UNTOUCHED config puts on the wire ──────────────────────────
  {
    const { child, state, waitFor } = launch(sandboxHome(port));
    try {
      assert(
        await waitFor((f) => f.includes("›"), "the prompt"),
        "the TUI starts and draws a composer",
      );
      assert(
        state.seen.includes(`${ESC}[?1049h`),
        "the default enters the alternate screen (pinned footer)",
        "in the normal buffer the redrawn region is content-sized, so the footer drifts up the moment the live-message area collapses",
      );
      assert(
        state.seen.includes(`${ESC}[?1000h`) && state.seen.includes(`${ESC}[?1006h`),
        "the wheel is captured in SGR form",
        "?1000h reports the button and ?1006h asks for it as ESC[<b;x;yM — bytes no keypress can produce",
      );
      assert(
        !state.seen.includes(`${ESC}[?1007h`),
        "alternate scroll is NEVER enabled",
        "?1007h is the mode that turns a wheel tick into arrow keys — the whole bug",
      );
      assert(
        !/\[\?(1002|1003)h/.test(state.seen),
        "motion reporting stays off",
        "?1002/?1003 are a packet per mouse move for a feature nothing reads, in a change that began as a report of lag",
      );
    } finally {
      child.kill();
    }
  }

  // ── 2. The tick scrolls the chat, and never types ─────────────────────────
  {
    const { child, text, nearPrompt, waitFor } = launch(sandboxHome(port));
    try {
      await waitFor((f) => f.includes("›"), "the prompt");
      // Text and Enter must be SEPARATE writes: sent together they are detected
      // as a paste, and Enter inside a paste inserts a newline.
      child.stdin.write("birinci soru");
      await sleep(200);
      child.stdin.write("\r");
      assert(await waitFor((f) => f.includes("satir 59"), "the answer"), "a turn completes");
      assert(
        text().includes("wheel scrolls"),
        "the hint names who owns the wheel HERE",
        "a footer that names a key doing nothing is how a working build reads as broken",
      );

      // The transcript has to have MEASURED itself: the scroll offset is clamped
      // to the measured content, so a tick arriving first is clamped to zero and
      // silently does nothing.
      await sleep(600);
      const mark = text().length;
      child.stdin.write(WHEEL_UP);
      await sleep(120);
      child.stdin.write(WHEEL_UP);
      assert(
        await waitFor(() => nearPrompt().includes("satır yukarıda"), "the scroll indicator", 8000),
        "a wheel tick SCROLLS the transcript",
        "this is the positive the two negatives below are anchored on — without it they also pass on a dead app",
      );
      assert(
        !text().slice(mark).includes("› birinci soru"),
        "…and does NOT recall the last prompt",
        "the reported bug: scrolling the chat put an old prompt back in the composer",
      );

      // Spaced, because a real wheel is: written back-to-back these six reports
      // and the ↑ below arrive as ONE stdin chunk, and Ink delivers a chunk as a
      // single key event — the arrow inside it stops being an arrow. No hand
      // produces six ticks and a keypress in the same millisecond.
      for (let i = 0; i < 6; i += 1) {
        child.stdin.write(WHEEL_DOWN);
        await sleep(40);
      }
      assert(
        await waitFor(() => !nearPrompt().includes("satır yukarıda"), "the bottom", 8000),
        "scrolling back down reaches the newest output",
        "asked of the LATEST frame — the indicator is a row that comes and goes, so the accumulated stream answers this permanently wrong",
      );

      // The second anchor. Every check above is equally true of a build whose
      // arrows are dead altogether, which would be a worse bug than the one
      // they cover.
      const keyMark = text().length;
      child.stdin.write(UP);
      assert(
        await waitFor(
          (f) => f.slice(keyMark).includes("› birinci soru"),
          "the recalled prompt",
          8000,
        ),
        "a real ↑ still recalls history",
      );
    } finally {
      if (process.env.KEEP_TRANSCRIPT === "1") {
        console.log(`\n--- transcript tail ---\n${text().slice(-3000)}`);
      }
      child.kill();
    }
  }

  // ── 3. Capture OFF captures NOTHING — it does not fall back to 1007 ───────
  {
    const { child, state, text, waitFor } = launch(
      sandboxHome(port, { fullscreen: true, mouse: false }),
    );
    try {
      await waitFor((f) => f.includes("›"), "the prompt");
      assert(
        !/\[\?(1000|1002|1003|1006)h/.test(state.seen),
        "tui.mouse: false enables no reporting mode",
        "this is the mode that exists so plain drag still selects text",
      );
      assert(
        !state.seen.includes(`${ESC}[?1007h`),
        "…and still never turns alternate scroll on",
        "falling back to 1007 here would restore the exact bug for anyone who wanted their drag back",
      );
      assert(
        text().includes("PgUp/PgDn scrolls"),
        "the hint switches to the keys that scroll in THAT mode",
      );
    } finally {
      child.kill();
    }
  }

  // ── 4. A KILLED session still gives the terminal back ─────────────────────
  {
    // The half no unmount covers, and the one capture made expensive: a session
    // that is killed rather than closed used to leave ?1000h/?1006h set, so the
    // user's shell printed `^[[<0;12;34M` on every click until `reset`. Ink's
    // teardown never runs for a signal, which is precisely when it matters —
    // the run that ends badly is the one that leaves a broken terminal AND no
    // explanation for it.
    const { child, state, waitFor } = launch(sandboxHome(port));
    try {
      await waitFor((f) => f.includes("›"), "the prompt");
      const pid = tuiPid(child.pid);
      assert(
        pid !== null,
        "the TUI process is found under the pty",
        "signalling `script` would prove nothing",
      );
      const mark = state.seen.length;
      if (pid !== null) process.kill(pid, "SIGTERM");
      // Waiting on the BYTES, not on the exit: `script` outlives its child by a
      // moment, and the restore is written before the process leaves.
      const gaveBack = async () => {
        const start = Date.now();
        while (Date.now() - start < 8000) {
          const tail = state.seen.slice(mark);
          if (tail.includes(`${ESC}[?1000l`) && tail.includes(`${ESC}[?1006l`)) return true;
          await sleep(100);
        }
        return false;
      };
      const ok = await gaveBack();
      const tail = state.seen.slice(mark);
      assert(
        ok,
        "SIGTERM switches mouse reporting back off",
        "left on, the terminal prints a mouse report on every click for the rest of that shell's life",
      );
      assert(tail.includes(`${ESC}[?25h`), "…and brings the hardware cursor back");
      assert(tail.includes(`${ESC}[?1049l`), "…and leaves the alternate screen");
    } finally {
      child.kill();
    }
  }

  server.close();
  // Counted, never spelled: a hardcoded denominator drifts the moment an
  // assertion is added.
  console.log(`\n${total - failures}/${total} PASS`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
