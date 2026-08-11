#!/usr/bin/env node
/**
 * Does something typed MID-TURN reach the model during that turn?
 *
 * The feature it guards replaces a queue that held the message until the turn
 * ended, so a correction arrived after the work it was meant to redirect. The
 * unit test proves the mechanism by severing one line; this asks the built
 * binary, in a real pty, with a real keystroke — and reads the answer off the
 * REQUEST BODIES rather than off the screen, because the screen can show a
 * message that never left the process.
 *
 * Run it after a build:
 *
 *     pnpm -r build && node scripts/soft-interrupt-e2e.mjs
 *
 * The fake model answers the first request with a tool call and every later one
 * with text, which is what creates the only legal injection point: after the
 * round's `tool_result` is recorded and before the next request. A model that
 * never calls a tool has no such point, and a script built on one would be
 * asserting that nothing happens.
 *
 * Anchored on both sides. "The interjection is in request #2" is worth nothing
 * unless request #2 exists and the turn was not silently restarted, so the
 * script also checks that the ORIGINAL prompt is still there and that the tool
 * round was not re-run — a cancel-and-resend would produce both a second copy
 * of the prompt and a fresh first request.
 *
 * 6/6 after, **4/6** against the binary built one commit earlier: there the
 * message waits for `turn_end`, so it appears in a LATER request as its own
 * turn rather than inside this one. The two that fail are the two that are the
 * feature; the four that pass on both are the anchors, and they are what stops
 * a green run from meaning "the TUI started".
 */

import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BIN = join(import.meta.dirname, "..", "packages", "cli", "dist", "main.js");
const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;?<]*[a-zA-Z]`, "g");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const INTERJECTION = "aslinda diger dosyaya bak";

/**
 * Records every request body, and answers the first one with a SLOW tool call.
 *
 * The three-second `sleep` is what makes the race winnable, and it is the only
 * reason this script measures the feature rather than its own timing: a tool
 * that returns instantly ends the round before a keystroke written from
 * JavaScript has crossed the pty, and the interjection then honestly belongs to
 * the next turn. The first draft used `echo` and failed for exactly that
 * reason — the harness, not the build.
 */
function fakeModel(state) {
  return createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
    });
    req.on("end", async () => {
      if (req.url.includes("/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "fake" }] }));
        return;
      }
      state.bodies.push(JSON.parse(raw));
      const n = state.bodies.length;
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (n === 1) {
        // A tool call, so the turn has a round to inject after.
        res.write(
          `data: ${JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_1",
                      type: "function",
                      function: { name: "bash", arguments: '{"command":"sleep 3; echo bir"}' },
                    },
                  ],
                },
              },
            ],
          })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\n\n`,
        );
      } else {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "tamam" } }] })}\n\n`);
        res.write(
          `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
        );
      }
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
}

function sandboxHome(port) {
  const home = mkdtempSync(join(tmpdir(), "arterm-soft-home-"));
  mkdirSync(join(home, ".arterm"), { recursive: true });
  writeFileSync(
    join(home, ".arterm", "config.json"),
    JSON.stringify(
      {
        provider: "openai-compat",
        model: "fake",
        openaiCompatHost: `http://127.0.0.1:${port}/v1`,
        sandbox: { enabled: false },
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

/** Every user-authored text in a request body, in order. */
function userTexts(body) {
  return (body.messages ?? [])
    .filter((m) => m.role === "user" && typeof m.content === "string")
    .map((m) => m.content);
}

/**
 * The pid of the actual TUI, not of `script`.
 *
 * `script -qec` runs the command through a shell, so the node process is a
 * GRANDCHILD. `child.kill()` signals only the pty wrapper, which leaves the TUI
 * running after the script exits — one orphaned node process per invocation,
 * each holding its temp HOME and a connection to the fake model, which is also
 * why `server.close()` could never complete. Same walk as
 * `wheel-scroll-e2e.mjs`, for the same reason.
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
  const state = { bodies: [] };
  const server = fakeModel(state);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;

  const cwd = mkdtempSync(join(tmpdir(), "arterm-soft-work-"));
  const child = spawn(
    "script",
    ["-qec", `stty rows 40 cols 120; node ${BIN} --yolo`, "/dev/null"],
    {
      cwd,
      env: { ...process.env, HOME: sandboxHome(port), NO_COLOR: "1" },
      stdio: ["pipe", "pipe", "inherit"],
    },
  );
  let seen = "";
  child.stdout.on("data", (c) => {
    seen += c;
  });
  const text = () => seen.replace(ANSI, "");
  const waitFor = async (pred, what, timeout = 30_000) => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (pred()) return true;
      await sleep(100);
    }
    console.log(`    (timed out waiting for ${what})`);
    return false;
  };

  try {
    assert(
      await waitFor(() => text().includes("›"), "the prompt"),
      "the TUI starts and draws a composer",
    );

    // Start the turn. Text and Enter are SEPARATE writes: sent together they
    // are detected as a paste, and Enter inside a paste inserts a newline.
    child.stdin.write("ilk soru");
    await sleep(250);
    child.stdin.write("\r");
    assert(
      await waitFor(() => state.bodies.length >= 1, "the first request"),
      "the turn starts and the model is called",
    );

    // Type WHILE it works — the tool round must still be in flight, which is
    // what the fake model's three-second tool buys.
    await sleep(200);
    child.stdin.write(INTERJECTION);
    await waitFor(() => text().includes(INTERJECTION), "the typed text", 8000);
    child.stdin.write("\r");

    assert(
      await waitFor(() => state.bodies.length >= 2, "the second request"),
      "the turn continues to a second request",
      "a cancel-and-resend would show up as a fresh FIRST request instead",
    );

    const second = state.bodies[1] ?? {};
    const texts = userTexts(second);
    assert(
      texts.includes(INTERJECTION),
      "the mid-turn message is IN that request",
      "this is the whole feature: it reached the model during the turn, not after it",
    );
    assert(
      texts.includes("ilk soru"),
      "…alongside the prompt that started the turn",
      "the anchor: a restarted turn would have re-sent the prompt on its own",
    );

    // Order is the contract the providers impose: every tool_use must be
    // answered by its tool_result before anything else may appear.
    const roles = (second.messages ?? []).map((m) => m.role);
    const lastTool = roles.lastIndexOf("tool");
    const injected = (second.messages ?? []).findIndex(
      (m) => m.role === "user" && m.content === INTERJECTION,
    );
    assert(
      lastTool >= 0 && injected > lastTool,
      "…and it sits AFTER the round's tool result",
      "injected between a tool_use and its tool_result, the provider rejects the request outright",
    );
  } finally {
    if (process.env.KEEP_TRANSCRIPT === "1") {
      console.log(`\n--- transcript tail ---\n${text().slice(-2500)}`);
    }
    // Signal the TUI itself, not the `script` wrapper: killing the wrapper
    // orphans the node grandchild, which then outlives this run holding its
    // temp HOME and a socket to the fake model below.
    const tui = tuiPid(child.pid);
    if (tui !== null) {
      try {
        process.kill(tui, "SIGTERM");
      } catch {
        // Already gone, which is the outcome this wanted.
      }
    }
    child.kill();
    server.close();
  }

  console.log(`\n${total - failures}/${total} PASS`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
