#!/usr/bin/env node
/**
 * A fake model server you can point a real `arterm` session at, to watch the
 * resilience layers work by hand.
 *
 * `provider-resilience-e2e.mjs` proves the same behavior automatically, but it
 * runs headless and tells you only pass/fail. This one stays up so you can drive
 * the TUI, curl the status server, and — most usefully — read the request log it
 * prints, which is where the timing shows: a switch to the fallback model on the
 * millisecond after the refusal is the whole point of the short-circuit, and no
 * assertion conveys that as plainly as two log lines 20ms apart.
 *
 * Speaks both APIs, so it works for `-p openai-compat` and `-p anthropic`:
 *   /v1/chat/completions + /v1/models   (OpenAI-compatible)
 *   /v1/messages                        (Anthropic Messages)
 *
 * Usage:
 *   node scripts/fault-server.mjs --mode quota-long [--port 8099] [--ok backup]
 *
 * `--tool <name>` answers with a tool call instead of text. `--tool task_done`
 * drives an autonomous run to a completion claim, which is what puts the result
 * verification gate on the path — without it the fake model never claims anything
 * and the gate is never consulted.
 *
 * Modes:
 *   ok            always answers normally
 *   quota-long    429 + `Retry-After: 3600` — retrying is abandoned at once
 *   quota-short   429 + `Retry-After: 2`    — inside the budget, so it IS retried
 *   quota-bare    429 with no Retry-After   — exponential backoff, then gives up
 *   overload      503 with no Retry-After   — retried, then gives up
 *   auth          401 — never retried, message names the fix
 *   drop-early    kills the FIRST request's socket before any output, then answers
 *                 — the replay makes the drop invisible to the user
 *   drop-mid      kills it after some text — NOT replayed, failure surfaces
 *   flaky:<n>     fails <n> times with 503, then answers
 *
 * `--ok <model>` (default "backup") names a model the server always answers
 * normally, whatever the mode. Configure it as a fallback and the chain has
 * somewhere to land:
 *
 *   {"fallbackModels": [{"model": "backup"}]}
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
function flag(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
const has = (name) => args.includes(`--${name}`);

const MODE = flag("mode", "quota-long");
const PORT = Number(flag("port", "8099"));
const OK_MODEL = flag("ok", "backup");
const ANSWER = flag("answer", "This answer came from the fake server.");
/** `--tool task_done` — answer with a tool call instead of text. */
const CALL_TOOL = flag("tool", undefined);

const flakyMatch = /^flaky:(\d+)$/.exec(MODE);
const FLAKY_FAILURES = flakyMatch ? Number(flakyMatch[1]) : 0;

const MODES = new Set([
  "ok",
  "quota-long",
  "quota-short",
  "quota-bare",
  "overload",
  "auth",
  "drop-early",
  "drop-mid",
]);
if (!MODES.has(MODE) && !flakyMatch) {
  console.error(`unknown --mode "${MODE}". See the header of this file for the list.`);
  process.exit(2);
}

let seq = 0;
let failuresSoFar = 0;
let lastAt = 0;

/** The log IS the test: it shows what was asked, what it got, and how long since the last one. */
function log(model, verdict) {
  const now = Date.now();
  const gap = lastAt ? `+${String(now - lastAt).padStart(5)}ms` : "   start";
  lastAt = now;
  const time = new Date(now).toISOString().slice(11, 23);
  console.log(`${time}  ${gap}  #${String(++seq).padEnd(3)} ${model.padEnd(24)} ${verdict}`);
}

function refuse(res, status, headers, message) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify({ error: { type: "error", message } }));
}

// ── OpenAI-compatible SSE ──
function openaiStream(res) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const frame = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  if (CALL_TOOL) {
    // `--tool <name>` makes the fake model call a tool instead of answering. With
    // `task_done` this is what drives an autonomous run to a completion CLAIM,
    // which is the only thing that puts the verification gate on the path.
    frame({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_1",
                type: "function",
                function: { name: CALL_TOOL, arguments: JSON.stringify({ summary: ANSWER }) },
              },
            ],
          },
        },
      ],
    });
    res.write("data: [DONE]\n\n");
    res.end();
    return;
  }
  frame({ choices: [{ delta: { content: ANSWER } }] });
  frame({ choices: [{ delta: {} }], usage: { prompt_tokens: 9, completion_tokens: 7 } });
  res.write("data: [DONE]\n\n");
  res.end();
}

// ── Anthropic Messages SSE ──
function anthropicStream(res) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const frame = (type, obj) => res.write(`event: ${type}\ndata: ${JSON.stringify(obj)}\n\n`);
  frame("message_start", {
    type: "message_start",
    message: {
      id: "msg_fake",
      type: "message",
      role: "assistant",
      model: "fake",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 9, output_tokens: 0 },
    },
  });
  frame("content_block_start", {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  });
  frame("content_block_delta", {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: ANSWER },
  });
  frame("content_block_stop", { type: "content_block_stop", index: 0 });
  frame("message_delta", {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: 7 },
  });
  frame("message_stop", { type: "message_stop" });
  res.end();
}

/** Apply the configured fault. Returns the verdict string for the log. */
function applyFault(res, stream) {
  switch (MODE) {
    case "ok":
      stream(res);
      return "200 ok";
    case "quota-long":
      refuse(res, 429, { "retry-after": "3600" }, "monthly quota exhausted");
      return "429 retry-after:3600  → retries abandoned";
    case "quota-short":
      refuse(res, 429, { "retry-after": "2" }, "slow down");
      return "429 retry-after:2     → waited out, retried";
    case "quota-bare":
      refuse(res, 429, {}, "rate limit exceeded");
      return "429 (no retry-after)  → backoff, then give up";
    case "overload":
      refuse(res, 503, {}, "model overloaded");
      return "503                   → retried";
    case "auth":
      refuse(res, 401, {}, "invalid api key");
      return "401                   → never retried";
    case "drop-early":
      // Only the first one: dropping every request just exhausts the replay budget
      // and shows a failure, which is the opposite of what this mode is for.
      if (failuresSoFar === 0) {
        failuresSoFar++;
        res.socket?.destroy();
        return "socket killed (no output) → replayed";
      }
      stream(res);
      return "200 ok (the replay landed here — user saw no failure)";
    case "drop-mid":
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "half a sen" } }] })}\n\n`);
      setTimeout(() => res.socket?.destroy(), 150);
      return "socket killed mid-answer → NOT replayed";
    default: {
      if (failuresSoFar < FLAKY_FAILURES) {
        failuresSoFar++;
        refuse(res, 503, {}, "temporarily unavailable");
        return `503 (${failuresSoFar}/${FLAKY_FAILURES} planned failures)`;
      }
      stream(res);
      return "200 ok (recovered)";
    }
  }
}

const server = createServer((req, res) => {
  const isAnthropic = req.url?.includes("/messages");
  const stream = isAnthropic ? anthropicStream : openaiStream;

  if (req.url?.endsWith("/models")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "fake" }, { id: OK_MODEL }] }));
    log("(model list)", "200 ok");
    return;
  }

  let body = "";
  req.on("data", (c) => {
    body += c;
  });
  req.on("end", () => {
    let model = "?";
    try {
      model = JSON.parse(body).model ?? "?";
    } catch {
      // A malformed body is the client's business, not ours.
    }
    // The escape hatch that makes fallback demonstrable: one model always works.
    if (model === OK_MODEL) {
      stream(res);
      log(model, "200 ok  ← the fallback answered");
      return;
    }
    log(model, applyFault(res, stream));
  });
});

/**
 * Prepare a throwaway HOME with the fallback already configured, and print the
 * one command that uses it.
 *
 * The alternative is telling someone to edit `~/.arterm/config.json`, which for a
 * five-minute experiment means editing the config they actually work with. A temp
 * HOME also keeps the status-server discovery files out of their real one.
 */
function makeSandbox() {
  const home = mkdtempSync(join(tmpdir(), "arterm-demo-"));
  mkdirSync(join(home, ".arterm"), { recursive: true });
  writeFileSync(
    join(home, ".arterm", "config.json"),
    `${JSON.stringify({ fallbackModels: [{ model: OK_MODEL }] }, null, 2)}\n`,
  );
  return home;
}

server.listen(PORT, "127.0.0.1", () => {
  const base = `http://127.0.0.1:${PORT}`;
  console.log(`fake model server on ${base}/v1   mode=${MODE}   ok-model=${OK_MODEL}`);
  console.log("");
  if (has("sandbox")) {
    const home = makeSandbox();
    console.log("A throwaway HOME is ready (your real ~/.arterm is untouched):");
    console.log(`  ${home}`);
    console.log("");
    console.log("Paste this into another terminal:");
    console.log("");
    console.log(
      `  HOME=${home} OPENAI_COMPAT_HOST=${base}/v1 arterm -p openai-compat -m fake --yolo`,
    );
    console.log("");
    console.log(`Then type anything and press Enter. Delete it after with:  rm -rf ${home}`);
  } else {
    console.log("Point a session at it (add --sandbox to get a throwaway HOME + config):");
    console.log("");
    console.log(`  OPENAI_COMPAT_HOST=${base}/v1 arterm -p openai-compat -m fake`);
    console.log(`  ANTHROPIC_BASE_URL=${base} ANTHROPIC_API_KEY=x arterm -p anthropic -m fake`);
  }
  console.log("");
  console.log("time          gap      #   model                    what the server did");
});
