#!/usr/bin/env node
/**
 * End-to-end proof that an `/sdd` worker is dispatched with its CONTEXT: the spec
 * the graph was cut from, and the output of the dependencies it was told to build
 * on. Both used to stop at the runner — the spec was written to disk for the human
 * and shown to no worker, and a dependent task received its dependency's *title*.
 *
 * Why a real process rather than a unit test: everything between `SddRunner` and
 * the model is production wiring nothing in-process exercises — `buildSession`'s
 * fleet runner, `runSubagent`, the provider. A unit test can prove the runner
 * builds the right string; only this can prove the string reaches the model.
 *
 * It drives the REAL `arterm` TUI in a pty against a fake OpenAI-compatible server
 * that records every request, then asserts on what the sub-agents were actually
 * sent. Requires a build (`pnpm -r build`).
 *
 *   node scripts/sdd-context-e2e.mjs [--keep]   # --keep prints the full transcript
 */

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = join(ROOT, "packages/cli/dist/main.js");
const KEEP = process.argv.includes("--keep");

// Distinctive markers. Every assertion below is "did this exact string survive the
// trip", which is immune to the model wording things differently.
const SPEC_RULE = "SPEC-RULE: reject with 429, never queue";
const OUT = {
  t1: "MEASURED: peak is 340 req/min from key ab12",
  t2: "CHOSEN: token bucket, 60s refill",
  t3: "IMPLEMENTED: limiter landed",
};
const SCOPE = "implement ONLY the task above";
const UPSTREAM_HEADING = "Results of the tasks you depend on";

const SPEC_REPLY = `# Rate limiting

${SPEC_RULE}. Per API key, never per IP.

\`\`\`json
{"tasks":[
  {"id":"t1","title":"measure current traffic","description":"read the access logs","dependsOn":[]},
  {"id":"t2","title":"choose an algorithm","description":"pick one and say why","dependsOn":[]},
  {"id":"t3","title":"implement the limiter","description":"write the middleware","dependsOn":["t1","t2"]}
]}
\`\`\``;

// ── fake model server ────────────────────────────────────────────────────────
/** Every chat request, in arrival order: the concatenated user text. */
const requests = [];

/** Newest user message — for a sub-agent that is the task prompt it was given. */
function userText(body) {
  const msgs = body.messages ?? [];
  return msgs
    .filter((m) => m.role === "user")
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
    .join("\n");
}

/** Tasks whose worker has already been made to call a tool (once each). */
const toolCalled = new Set();

/**
 * Decide what the fake model says, from what it was asked. Returns a string to
 * answer with text, or `{tool}` to answer with a tool call.
 */
function reply(text) {
  if (text.includes("implementation SPEC")) return SPEC_REPLY;
  if (text.includes("clarifying questions")) return "[]";
  // One real tool call from the first worker, so the kanban's drill-down feed has
  // something to show. It is routed to a row by id, which is exactly what the
  // graph ids buy: the feed reaching the task it belongs to.
  if (text.includes("measure current traffic") && !toolCalled.has("t1")) {
    toolCalled.add("t1");
    return { tool: "ls" };
  }
  // A worker: answer as that task, so the next wave has something recognisable to
  // have received. Match on the task title, which opens the prompt.
  if (text.includes("measure current traffic")) return OUT.t1;
  if (text.includes("choose an algorithm")) return OUT.t2;
  if (text.includes("implement the limiter")) return OUT.t3;
  // The verification judge, or anything else: plain text. No `submit_verdict`
  // tool call, so the gate fails open — which is the documented behavior and
  // keeps this test about the handoff rather than about verification.
  return "Looks fine.";
}

const server = createServer((req, res) => {
  if (req.url?.endsWith("/models")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "fake" }] }));
    return;
  }
  let raw = "";
  req.on("data", (c) => {
    raw += c;
  });
  req.on("end", () => {
    let text = "";
    try {
      text = userText(JSON.parse(raw));
    } catch {
      // Malformed bodies are the client's problem; record the empty string.
    }
    requests.push(text);
    const answer = reply(text);
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const delta =
      typeof answer === "string"
        ? { content: answer }
        : {
            tool_calls: [
              {
                index: 0,
                id: "call_1",
                type: "function",
                function: { name: answer.tool, arguments: "{}" },
              },
            ],
          };
    res.write(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`);
    res.write(
      `data: ${JSON.stringify({
        choices: [{ delta: {} }],
        usage: { prompt_tokens: 10, completion_tokens: 10 },
      })}\n\n`,
    );
    res.write("data: [DONE]\n\n");
    res.end();
  });
});

/** A throwaway HOME: its own config and status dir, so the real one is untouched. */
function sandbox(port) {
  const home = mkdtempSync(join(tmpdir(), "arterm-sdd-e2e-"));
  mkdirSync(join(home, ".arterm"), { recursive: true });
  writeFileSync(
    join(home, ".arterm", "config.json"),
    JSON.stringify(
      {
        provider: "openai-compat",
        model: "fake",
        openaiCompatHost: `http://127.0.0.1:${port}/v1`,
        // Keep the run to the thing under test: no catalog fetch, no transcript,
        // no memory injection, no status server. `tui.fullscreen: false` makes the
        // frame plain scrolling lines, which is what we grep for completion.
        catalog: { enabled: false },
        session: { mode: "off" },
        memory: { mode: "off" },
        statusServer: { enabled: false },
        tui: { fullscreen: false, mouse: false },
        // `SDD_E2E_CONTEXT=off` reproduces the pre-fix dispatch exactly (both
        // budgets zero). Run it that way to confirm these assertions have teeth:
        // a context test that passes with the context switched off proves nothing.
        ...(process.env.SDD_E2E_CONTEXT === "off"
          ? { sdd: { specChars: 0, handoffChars: 0 } }
          : {}),
      },
      null,
      2,
    ),
  );
  return home;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const home = sandbox(port);

  // A pty with a real size: with stdout redirected, `script`'s pty is 0x0 and Ink
  // renders a blank screen — indistinguishable from a hang. Read the session from
  // the child's stdout rather than script's typescript FILE, which is buffered and
  // stays empty until the process exits (a live poll of it never sees anything).
  const child = spawn("script", ["-qec", `stty rows 45 cols 200; node ${BIN}`, "/dev/null"], {
    env: { ...process.env, HOME: home, NO_COLOR: "1" },
    stdio: ["pipe", "pipe", "inherit"],
  });

  let seen = "";
  child.stdout.on("data", (c) => {
    seen += c;
  });
  const frame = () => seen;
  const waitFor = async (pred, what, timeout = 60_000) => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (pred(frame())) return;
      await sleep(200);
    }
    throw new Error(`timed out waiting for ${what}\n--- last frame ---\n${frame().slice(-3000)}`);
  };

  try {
    await waitFor((f) => /ready|›|>/.test(f), "the prompt");
    // Text and Enter must be SEPARATE writes: sent together they are detected as a
    // paste, and Enter inside a paste inserts a newline instead of submitting.
    child.stdin.write("/sdd add rate limiting --yes");
    await sleep(900);
    child.stdin.write("\r");

    await waitFor((f) => f.includes("/sdd complete"), "the run to finish");
    await sleep(400);

    // Enter on an empty prompt opens the selected task's drill-down. The kanban is
    // the only board an /sdd run raises, so this is the one way to see what a
    // worker did — it exists only because the tasks carry the graph's own ids,
    // which is what routes the activity feed to the right row.
    child.stdin.write("\r");
    await sleep(700);

    check(frame());
  } finally {
    child.stdin.write("");
    child.kill();
    server.close();
    if (KEEP) console.log(`\n--- transcript ---\n${frame()}`);
  }
}

// ── assertions ───────────────────────────────────────────────────────────────
let failures = 0;
function assert(ok, label, detail = "") {
  console.log(`${ok ? "✓" : "✗"} ${label}${ok || !detail ? "" : `\n    ${detail}`}`);
  if (!ok) failures += 1;
}

/**
 * The request carrying this task's prompt. The verification judge is also handed
 * the task's title, but always after the worker ran, so the FIRST match is the
 * worker's own turn.
 */
function workerPrompt(title) {
  return requests.find((r) => r.includes(`${title}\n\n`));
}

function check(transcript) {
  console.log(`\n${requests.length} model requests recorded\n`);

  assert(
    transcript.includes("3 done"),
    "the TUI reports 3 tasks done",
    firstLine(transcript, "/sdd complete"),
  );
  // The kanban is the view for an /sdd run. A second board for the same wave would
  // now be printing each worker's whole prompt — this is only visible on a live
  // screen, which is the other reason this test drives a real terminal.
  assert(!transcript.includes("⛓ fleet  —"), "no duplicate fleet board next to the /sdd kanban");
  // The worker's prompt is a document now. Anywhere the TUI treats it as a label —
  // a board row, a `⟳ sub-agent:` line — it must collapse to one line, or the
  // transcript fills with the same boilerplate on every dispatch.
  assert(
    !transcript.includes("The spec this task comes from"),
    "no prompt boilerplate leaks into the transcript",
    firstLine(transcript, "The spec this task comes from"),
  );
  // ⏎ on an empty prompt opened a task's activity feed. The kanban is the only
  // board an /sdd run raises, so without this there is no way to see what a worker
  // did; the feed reaches the right row only because the task carries its graph id.
  assert(transcript.includes("⏎ inspect"), "the kanban advertises its drill-down");
  assert(
    /⚙ t1 measure current traffic/.test(transcript),
    "⏎ opens the selected task's drill-down on the kanban",
    firstLine(transcript, "⚙ t"),
  );
  assert(
    transcript.includes("⚙ ls"),
    "the worker's tool call reached that task's feed",
    "the feed is keyed by id — a synthetic fleet id would have stranded it",
  );

  const t1 = workerPrompt("measure current traffic");
  const t3 = workerPrompt("implement the limiter");
  assert(!!t1, "wave-1 worker was dispatched");
  assert(!!t3, "wave-2 worker was dispatched");
  if (!t1 || !t3) return;

  assert(t1.includes(SPEC_RULE), "wave-1 worker received the spec");
  assert(t1.includes(SCOPE), "the prompt tells it to implement only its own task");
  assert(!t1.includes(UPSTREAM_HEADING), "a task with no dependencies gets no upstream section");

  assert(t3.includes(SPEC_RULE), "wave-2 worker received the spec");
  assert(
    t3.includes(OUT.t1),
    "wave-2 worker received dependency t1's OUTPUT",
    `expected: ${OUT.t1}`,
  );
  assert(
    t3.includes(OUT.t2),
    "wave-2 worker received dependency t2's OUTPUT",
    `expected: ${OUT.t2}`,
  );
  assert(
    t3.indexOf(SPEC_RULE) < t3.indexOf(OUT.t1),
    "order holds: task, then spec, then upstream results",
  );
  assert(!t3.includes(OUT.t3), "a worker is not handed its own output");
}

function firstLine(text, needle) {
  return (
    text
      .split("\n")
      .find((l) => l.includes(needle))
      ?.trim() ?? ""
  );
}

main()
  .then(() => {
    console.log(failures === 0 ? "\nPASS" : `\nFAIL (${failures})`);
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch((err) => {
    console.error(`\nFAIL: ${err.message}`);
    process.exit(1);
  });
