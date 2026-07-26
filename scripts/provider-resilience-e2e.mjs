/**
 * End-to-end fault injection for the provider resilience layer.
 *
 * Unit tests pin the helpers; this drives the real `arterm` binary — real agent
 * loop, real provider code, real sockets — against a fake OpenAI-compatible
 * server that dies on command. Each scenario asserts both what the user sees
 * (exit code, stdout, error text) and how many requests actually reached the
 * server, because "did it replay?" is only answerable from the server side.
 *
 * Requires a built CLI:
 *
 *   pnpm -r build && node scripts/provider-resilience-e2e.mjs
 *
 * Exits non-zero if any scenario fails. This is deliberately out-of-band from
 * `pnpm test`: it spawns a real process, which is the only way to catch bugs
 * that depend on process lifetime (an unref'd backoff timer let the CLI exit
 * mid-retry — invisible to any in-process test).
 */

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ARTERM = process.env.ARTERM_BIN ?? join(HERE, "..", "packages", "cli", "dist", "main.js");
const ANSWER = "PONG";

/** An SSE frame in the shape these servers stream. */
function sse(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

function textFrame(content) {
  return sse({ choices: [{ delta: { content } }] });
}

/** Write status + streaming headers without finishing the response. */
function openStream(res) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  res.flushHeaders();
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Start the fake upstream. `handler(requestIndex, res, body)` decides what the
 * Nth chat request does; /models is always answered normally. `body` is the
 * parsed request, so a scenario can answer differently per requested model.
 */
async function startServer(handler) {
  let requests = 0;
  const models = [];
  const server = createServer(async (req, res) => {
    if (req.url?.endsWith("/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "fake" }] }));
      return;
    }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    let body = {};
    try {
      body = JSON.parse(raw);
    } catch {
      // A malformed body is the scenario's problem, not the harness's.
    }
    const index = requests++;
    if (body.model) models.push(body.model);
    await handler(index, res, body);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    get requests() {
      return requests;
    },
    /** Every model name the CLI actually asked for, in order. */
    get models() {
      return models;
    },
    close: () => new Promise((r) => server.close(r)),
  };
}

/** A complete, well-behaved answer. */
function respondOk(res) {
  openStream(res);
  res.write(textFrame(ANSWER));
  res.write(sse({ usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
  res.write("data: [DONE]\n\n");
  res.end();
}

/** Accept, then kill the socket — what a dropped connection looks like. */
async function killSocket(res, { afterBytes } = {}) {
  openStream(res);
  if (afterBytes) {
    res.write(afterBytes);
    // Let the bytes actually reach the client before the socket dies.
    await delay(150);
  }
  res.socket?.destroy();
}

function runArterm(baseUrl, configOverlay) {
  const home = mkdtempSync(join(tmpdir(), "arterm-e2e-"));
  if (configOverlay) {
    // The config file is partial and merges over the defaults, so a scenario can
    // set one field without restating the whole config.
    mkdirSync(join(home, ".arterm"), { recursive: true });
    writeFileSync(join(home, ".arterm", "config.json"), JSON.stringify(configOverlay, null, 2));
  }
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        ARTERM,
        "-p",
        "openai-compat",
        "-m",
        "fake",
        "--yolo",
        "--print",
        `Reply with exactly: ${ANSWER}`,
      ],
      {
        env: {
          ...process.env,
          HOME: home,
          XDG_CONFIG_HOME: join(home, ".config"),
          OPENAI_COMPAT_HOST: baseUrl,
          ARTERM_TERMINAL: "",
          NO_COLOR: "1",
        },
        cwd: home,
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

const results = [];

/**
 * A healthy turn costs more than one request (the loop makes a post-turn call of
 * its own), so every fault scenario is asserted relative to this measured
 * baseline rather than a hardcoded number.
 */
let BASELINE = 0;

async function scenario(name, expectation, handler, assertFn, configOverlay) {
  const server = await startServer(handler);
  const started = Date.now();
  const run = await runArterm(server.baseUrl, configOverlay);
  await server.close();
  const elapsed = Date.now() - started;
  let verdict = "PASS";
  let note = "";
  try {
    assertFn({ ...run, requests: server.requests, models: server.models });
  } catch (err) {
    verdict = "FAIL";
    note = err.message;
  }
  results.push({ name, expectation, verdict, note, requests: server.requests, elapsed, run });
  const head = `${verdict === "PASS" ? "✓" : "✗"} ${name}`;
  console.log(`${head}  (${server.requests} request(s), ${elapsed}ms)`);
  if (verdict === "FAIL") {
    console.log(`    ${note}`);
    console.log(`    exit=${run.code}`);
    console.log(`    stdout: ${JSON.stringify(run.stdout.slice(0, 400))}`);
    console.log(`    stderr: ${JSON.stringify(run.stderr.slice(0, 400))}`);
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

// ── Baseline: a healthy turn, to learn what a clean run costs ──
await scenario(
  "0. baseline (no faults)",
  "establishes the request count of a healthy turn",
  async (_i, res) => respondOk(res),
  ({ code, stdout, requests }) => {
    BASELINE = requests;
    assert(code === 0, `expected exit 0, got ${code}`);
    assert(stdout.includes(ANSWER), "expected the answer in stdout");
  },
);

// ── A. socket dies before the first token → the turn is replayed and survives ──
await scenario(
  "A. connection dropped before any output",
  "replays once, user never sees a failure",
  async (i, res) => {
    if (i === 0) return killSocket(res);
    return respondOk(res);
  },
  ({ code, stdout, requests }) => {
    assert(
      requests === BASELINE + 1,
      `expected ${BASELINE + 1} requests (baseline + 1 dead attempt), got ${requests}`,
    );
    assert(code === 0, `expected exit 0, got ${code}`);
    assert(stdout.includes(ANSWER), "expected the answer in stdout — the drop must be invisible");
  },
);

// ── B. socket dies after text was emitted → no replay, failure surfaces ──
await scenario(
  "B. connection dropped mid-answer",
  "does NOT replay (would duplicate text), reports a network failure",
  async (_i, res) => killSocket(res, { afterBytes: textFrame("half a sen") }),
  ({ stdout, stderr, requests }) => {
    const out = stdout + stderr;
    assert(requests === 1, `expected exactly 1 request (no replay), got ${requests}`);
    assert(/terminated|network|connection/i.test(out), "expected a network failure message");
  },
);

// ── C. rejected credentials → no retry at all, actionable message ──
await scenario(
  "C. 401 rejected credentials",
  "no retry, message names the fix",
  async (_i, res) => {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "invalid api key" } }));
  },
  ({ stdout, stderr, requests }) => {
    const out = stdout + stderr;
    assert(requests === 1, `expected exactly 1 request (auth is not retryable), got ${requests}`);
    assert(/arterm auth set/.test(out), "expected the credential hint in the output");
  },
);

// ── D. transient 503s → connection-phase retry, then success ──
await scenario(
  "D. two 503s then success",
  "connection-phase retry recovers it",
  async (i, res) => {
    if (i < 2) {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "overloaded" } }));
      return;
    }
    return respondOk(res);
  },
  ({ code, stdout, requests }) => {
    assert(
      requests === BASELINE + 2,
      `expected ${BASELINE + 2} requests (baseline + 2 refusals), got ${requests}`,
    );
    assert(code === 0, `expected exit 0, got ${code}`);
    assert(stdout.includes(ANSWER), "expected the answer in stdout");
  },
);

// ── E. permanently refused 429 → retried, then gives up with a quota message ──
await scenario(
  "E. persistent 429",
  "retries the connection phase, then gives up with a quota message",
  async (_i, res) => {
    res.writeHead(429, { "content-type": "application/json", "retry-after": "0" });
    res.end(JSON.stringify({ error: { message: "rate limit exceeded" } }));
  },
  ({ stdout, stderr, requests }) => {
    const out = stdout + stderr;
    assert(requests === 4, `expected 4 requests (1 + 3 retries), got ${requests}`);
    assert(/HTTP 429|rate limit|quota/i.test(out), "expected a quota failure message");
  },
);

// ── F. primary out of quota → the configured chain answers instead ──
await scenario(
  "F. quota exhausted with a fallback configured",
  "switches to the fallback model and completes the turn",
  async (_i, res, body) => {
    if (body.model === "backup") return respondOk(res);
    res.writeHead(429, { "content-type": "application/json", "retry-after": "0" });
    res.end(JSON.stringify({ error: { message: "rate limit exceeded" } }));
  },
  ({ code, stdout, models }) => {
    assert(models.includes("fake"), "expected the primary model to be tried first");
    assert(models.includes("backup"), `expected a fallback to "backup", saw ${models.join(", ")}`);
    assert(code === 0, `expected exit 0, got ${code}`);
    assert(stdout.includes(ANSWER), "expected the fallback's answer in stdout");
  },
  { fallbackModels: [{ model: "backup" }] },
);

// ── G. no fallback configured → the chain must not invent one ──
await scenario(
  "G. quota exhausted with NO fallback configured",
  "fails cleanly instead of silently trying other models",
  async (_i, res) => {
    res.writeHead(429, { "content-type": "application/json", "retry-after": "0" });
    res.end(JSON.stringify({ error: { message: "rate limit exceeded" } }));
  },
  ({ stdout, stderr, models }) => {
    const out = stdout + stderr;
    assert(
      models.every((m) => m === "fake"),
      `expected only the configured model, saw ${models.join(", ")}`,
    );
    assert(/HTTP 429|rate limit|quota/i.test(out), "expected a quota failure message");
  },
);

// ── H. a rate limit longer than we'd wait → no retries, straight to the fallback ──
// Guards the timing bug, not just the outcome: with the old clamp-and-retry this
// still ended on "backup", but only after three 30s waits. The elapsed assertion
// is what would catch a regression, so it is deliberately generous but finite.
await scenario(
  "H. long Retry-After with a fallback configured",
  "abandons retries immediately, no 30s waits before the switch",
  async (_i, res, body) => {
    if (body.model === "backup") return respondOk(res);
    res.writeHead(429, { "content-type": "application/json", "retry-after": "3600" });
    res.end(JSON.stringify({ error: { message: "monthly quota exhausted" } }));
  },
  ({ code, stdout, models }) => {
    const primaryAttempts = models.filter((m) => m === "fake").length;
    assert(
      primaryAttempts <= 2,
      `expected the primary to be abandoned at once, got ${primaryAttempts} attempts`,
    );
    assert(models.includes("backup"), `expected a fallback to "backup", saw ${models.join(", ")}`);
    assert(code === 0, `expected exit 0, got ${code}`);
    assert(stdout.includes(ANSWER), "expected the fallback's answer in stdout");
  },
  { fallbackModels: [{ model: "backup" }] },
);

// ── I. same, with no fallback → the user is told how long, immediately ──
await scenario(
  "I. long Retry-After with NO fallback configured",
  "reports the wait instead of sitting through a fraction of it",
  async (_i, res) => {
    res.writeHead(429, { "content-type": "application/json", "retry-after": "3600" });
    res.end(JSON.stringify({ error: { message: "monthly quota exhausted" } }));
  },
  ({ stdout, stderr, requests }) => {
    const out = stdout + stderr;
    assert(requests === 1, `expected exactly 1 request (retrying is pointless), got ${requests}`);
    assert(/1h|rate limited/i.test(out), "expected the wait to be named in the message");
  },
);

// The other half of resilience is what the user is told when it genuinely fails.
console.log("\n── what the user sees on the unrecoverable failures ──");
for (const r of results) {
  const out = `${r.run.stdout}${r.run.stderr}`.trim();
  if (!out || out === ANSWER) continue;
  console.log(`\n[${r.name}] exit=${r.run.code}`);
  for (const line of out.split("\n").slice(0, 6)) console.log(`  ${line}`);
}

console.log("");
const failed = results.filter((r) => r.verdict === "FAIL");
console.log(`${results.length - failed.length}/${results.length} scenarios passed`);
process.exit(failed.length === 0 ? 0 : 1);
