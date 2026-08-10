#!/usr/bin/env node
/**
 * Parallel mode, end to end: do the WORKERS do the work, does the LEDGER say
 * which worker, and does a red standing command become the next round's steer?
 *
 * Born from a live GLM run that scored 19/21 on its own suite and then idled
 * out without anyone being told about the two failures. (The same run was
 * FIRST misread as "78 unstamped tool executions" — the analysis script read
 * `record.agentId` where the stamp lives at `record.scope.agentId`; read
 * correctly, all four workers were stamped and the leader executed nothing.
 * The stamp checks below read the right field and keep it honest.) The
 * integration step, though, ran on `run()` with the full roster offered and
 * one prose sentence standing between the leader and the fleet's job — this
 * fake answers "Integrate them" with a tool call to demonstrate exactly that
 * hijack, which the pre-fix binary executes.
 *
 * Run it after a build:
 *
 *     pnpm -r build && node scripts/parallel-fleet-e2e.mjs
 *
 * The fake routes by PROMPT SHAPE, not by call order: concurrency makes order
 * nondeterministic, and a shape is what the engine actually varies.
 *   - decompose  ("LEADER of a parallel sub-agent fleet") → round 1: two
 *     subtasks; every later round: [] — the shape of a leader gone idle.
 *   - worker     ("Create <name>.txt")                    → one write tool
 *     call, then "done".
 *   - integrate  ("Integrate them")                       → a WRITE TOOL CALL
 *     for leader-escape.txt. Post-fix this is text nobody executes; pre-fix
 *     it was a real write on the parent, unstamped by construction.
 *   - assess     ("Reply with exactly")                   → "CONTINUE",
 *     always — the run must end by cap or idle-out, never by claim, because
 *     the hole being tested is what happens BETWEEN claims.
 *
 * The standing command (`test -f green-marker.txt`) is red for the whole run:
 * nothing creates the marker. Pre-fix, two empty decomposes idle the run out
 * with "no further parallel work proposed" and the red suite is never spoken.
 * Post-fix, every empty round steers ("standing verification command is
 * FAILING") and the run ends at the round cap instead.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ARTERM = join(HERE, "..", "packages", "cli", "dist", "main.js");
const PORT = 8177;

const home = mkdtempSync(join(tmpdir(), "arterm-parfleet-home-"));
const work = mkdtempSync(join(tmpdir(), "arterm-parfleet-work-"));
writeFileSync(
  join(home, "config.json"),
  JSON.stringify({
    provider: "openai-compat",
    model: "fake",
    openaiCompatHost: `http://127.0.0.1:${PORT}/v1`,
    // The standing gate under test. Red all run: nothing writes the marker.
    verify: { command: "test -f green-marker.txt" },
  }),
);

const decomposePrompts = [];
let decomposeCalls = 0;

function sse(res, events) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const e of events) res.write(`data: ${JSON.stringify(e)}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}
const text = (t) => [
  { choices: [{ delta: { content: t } }] },
  {
    choices: [{ delta: {}, finish_reason: "stop" }],
    usage: { prompt_tokens: 5, completion_tokens: 5 },
  },
];
const toolCall = (name, args) => [
  {
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              id: `c${Math.floor(Math.random() * 1e6)}`,
              type: "function",
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        },
      },
    ],
  },
  {
    choices: [{ delta: {}, finish_reason: "tool_calls" }],
    usage: { prompt_tokens: 5, completion_tokens: 5 },
  },
];

const server = createServer((req, res) => {
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
    let messages = [];
    try {
      messages = JSON.parse(raw).messages ?? [];
    } catch {}
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    const prompt =
      typeof lastUser?.content === "string"
        ? lastUser.content
        : JSON.stringify(lastUser?.content ?? "");
    const hasToolResult = messages.some((m) => m.role === "tool");

    if (prompt.includes("LEADER of a parallel sub-agent fleet")) {
      decomposeCalls += 1;
      decomposePrompts.push(prompt);
      sse(
        res,
        text(
          decomposeCalls === 1
            ? '[{"task":"Create alpha.txt with the write tool","role":"implementer"},{"task":"Create beta.txt with the write tool","role":"tester"}]'
            : "[]",
        ),
      );
      return;
    }
    if (prompt.includes("Integrate them")) {
      // The behavior measured on the live run: the leader answers the
      // integration prompt with WORK. Post-fix there are no tools on this
      // request, so this arrives as chunks the note() reader ignores.
      sse(res, toolCall("write", { path: "leader-escape.txt", content: "should never exist" }));
      return;
    }
    if (prompt.includes("Reply with exactly")) {
      sse(res, text("CONTINUE — keep going"));
      return;
    }
    if (prompt.includes("alpha.txt") || prompt.includes("beta.txt")) {
      const name = prompt.includes("alpha.txt") ? "alpha.txt" : "beta.txt";
      sse(
        res,
        hasToolResult
          ? text("done")
          : toolCall("write", { path: name, content: name.toUpperCase() }),
      );
      return;
    }
    sse(res, text("ok"));
  });
});

const checks = [];
const check = (label, ok, detail = "") => {
  checks.push(ok);
  console.log(`${ok ? "ok    " : "FAIL  "}${label}${detail ? `\n        ${detail}` : ""}`);
};

await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

let out = "";
const proc = spawn(
  process.execPath,
  [
    ARTERM,
    "--print",
    "--json",
    "--yolo",
    "--autonomy-mode",
    "parallel",
    "--max-steps",
    "3",
    "--goal",
    "build the two files",
  ],
  {
    cwd: work,
    env: { ...process.env, ARTERM_HOME: home, OPENAI_COMPAT_API_KEY: "x", NO_COLOR: "1" },
  },
);
proc.stdout.on("data", (c) => {
  out += c;
});
proc.stderr.on("data", (c) => {
  out += c;
});
const timer = setTimeout(() => proc.kill("SIGKILL"), 120_000);
await new Promise((r) => proc.on("close", r));
clearTimeout(timer);
await new Promise((r) => server.close(r));

// ── the workers did the work ────────────────────────────────────────────────
check(
  "both workers' files exist",
  existsSync(join(work, "alpha.txt")) && existsSync(join(work, "beta.txt")),
);
check(
  "the leader's integration turn executed NOTHING",
  !existsSync(join(work, "leader-escape.txt")),
  "the fake answers 'Integrate them' with a write tool call — note() must have no tools to run it with",
);

// ── the ledger says WHICH worker ────────────────────────────────────────────
const chronicleDir = join(home, "chronicle");
const records = readdirSync(chronicleDir)
  .filter((f) => f.endsWith(".jsonl"))
  .flatMap((f) =>
    readFileSync(join(chronicleDir, f), "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l)),
  );
const writes = records.filter((r) => r.toolName === "write");
const stamp = (r) => r?.scope?.agentId ?? "";
const byFile = (name) => writes.find((r) => r.change?.path === name);
check(
  "alpha.txt's record is stamped with its worker's id",
  /r1-1|implementer/.test(stamp(byFile("alpha.txt"))),
  `agentId: ${JSON.stringify(stamp(byFile("alpha.txt")) || null)}`,
);
check(
  "beta.txt's record is stamped with its worker's id",
  /r1-2|tester/.test(stamp(byFile("beta.txt"))),
  `agentId: ${JSON.stringify(stamp(byFile("beta.txt")) || null)}`,
);
check(
  "no write in the ledger is unstamped",
  writes.every((r) => stamp(r).length > 0),
  `${writes.length} write record(s)`,
);

// ── red between claims becomes a steer, not an idle-out ─────────────────────
check(
  "the red standing command reached the leader as a steer",
  decomposePrompts.slice(1).some((p) => p.includes("standing verification command is FAILING")),
  `decompose calls: ${decomposeCalls}`,
);
check(
  "the run ended at the round cap, not by idling out over a red suite",
  out.includes("reached round limit") || /round limit/.test(out),
  (out.match(/■[^\n]*/g) ?? []).join(" | ").slice(0, 160),
);
check(
  "'no further parallel work proposed' is gone from a red run",
  !out.includes("no further parallel work proposed"),
);

const passed = checks.filter(Boolean).length;
console.log(`\n${passed}/${checks.length} ${passed === checks.length ? "PASS" : "FAIL"}`);
process.exit(passed === checks.length ? 0 : 1);
