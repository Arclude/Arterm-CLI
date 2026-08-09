#!/usr/bin/env node
/**
 * Does a run that hits its wall-clock deadline STOP, and then EXIT?
 *
 * Two properties, and they failed independently — which is why both are checked
 * here rather than trusted to one.
 *
 * The deadline used to be a `request` pipeline stage, so it refused the NEXT
 * call and could not end one in flight. On a real benchmark trial that left 120
 * seconds of margin unused: the gate never fired, the harness killed the process
 * at its own 900s limit, and the result file was 0 bytes.
 *
 * Then, with the deadline landing correctly, the process still would not exit —
 * `digest()` runs at TEARDOWN, after the loop has stopped and the document has
 * been written, and it makes its own model call with no signal at all. The run
 * stopped on time and the process sat there for another eighty seconds, which to
 * a harness is indistinguishable from never having stopped.
 *
 * `--mode slow-stream` is the fault neither `streamIdleGuard` nor a step cap can
 * see: a server that never goes quiet and never finishes. Every chunk resets an
 * idle timer, so "still producing" and "still useful" look identical, and only a
 * deadline separates them.
 *
 *   node scripts/deadline-exit-e2e.mjs
 *
 * Run it after a build. No API key: it drives the built binary against the fake.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ARTERM = join(HERE, "..", "packages", "cli", "dist", "main.js");
const FAKE = join(HERE, "fault-server.mjs");
const PORT = 8145;

/** The run's own ceiling. */
const BUDGET_SEC = 8;

/**
 * How long past the budget the process may take to disappear.
 *
 * Generous on purpose: this must fail on "never exits", not on "exited slowly on
 * a loaded machine". The bug it catches overran by 80 seconds and was bounded
 * only by an external kill, so any modest ceiling separates the two.
 */
const EXIT_GRACE_SEC = 20;

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function runToDeadline() {
  const home = mkdtempSync(join(tmpdir(), "arterm-deadline-e2e-"));
  mkdirSync(join(home, ".arterm"), { recursive: true });
  // Pin the host in config as well as the environment: the CLI persists its
  // whole config on exit, and a stale saved host silently redirects the next run
  // away from the fake server.
  writeFileSync(
    join(home, ".arterm", "config.json"),
    JSON.stringify({
      provider: "openai-compat",
      model: "fake",
      openaiCompatHost: `http://127.0.0.1:${PORT}/v1`,
      session: { mode: "off" },
      telemetry: { enabled: false },
    }),
  );
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(
      process.execPath,
      [
        ARTERM,
        "--print",
        "--json",
        "--yolo",
        "--no-sandbox",
        "--no-status-server",
        "--max-steps",
        "200",
        "--max-duration",
        String(BUDGET_SEC),
        "--goal",
        "do the thing",
      ],
      {
        env: {
          ...process.env,
          HOME: home,
          XDG_CONFIG_HOME: join(home, ".config"),
          OPENAI_COMPAT_HOST: `http://127.0.0.1:${PORT}/v1`,
          OPENAI_API_KEY: "fake-key",
          ARTERM_TERMINAL: "",
          NO_COLOR: "1",
        },
        cwd: home,
      },
    );
    let stdout = "";
    let stderr = "";
    let killed = false;
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    const hammer = setTimeout(
      () => {
        killed = true;
        child.kill("SIGKILL");
      },
      (BUDGET_SEC + EXIT_GRACE_SEC) * 1000,
    );
    child.on("close", (code) => {
      clearTimeout(hammer);
      resolve({ code, stdout, stderr, killed, elapsedSec: (Date.now() - started) / 1000 });
    });
  });
}

const results = [];
function check(name, ok, note) {
  results.push({ name, ok, note });
  console.log(`${ok ? "✓" : "✗"} ${name}${note ? `  — ${note}` : ""}`);
}

const server = spawn(process.execPath, [FAKE, "--mode", "slow-stream", "--port", String(PORT)], {
  stdio: "ignore",
});
await delay(700);

try {
  const run = await runToDeadline();

  // SIGKILL here means the process had to be destroyed: the exact failure.
  check(
    "the process exits on its own",
    !run.killed,
    `killed=${run.killed} exit=${run.code} after ${run.elapsedSec.toFixed(1)}s`,
  );

  let doc;
  try {
    doc = JSON.parse(run.stdout);
  } catch (err) {
    check("it wrote a result document", false, String(err).slice(0, 100));
  }

  if (doc) {
    check("it wrote a result document", true, `state=${doc.state}`);
    check(
      "it stopped BECAUSE of the clock, not something else",
      doc.state === "stopped" &&
        /budget spent/.test(doc.summary ?? "") &&
        /elapsed/.test(doc.summary ?? ""),
      JSON.stringify(doc.summary ?? "").slice(0, 80),
    );
    const budget = doc.guards?.budget;
    check(
      "the budget block reports the ceiling it hit",
      budget?.limitSeconds === BUDGET_SEC && budget?.breached === true,
      JSON.stringify(budget ?? null).slice(0, 110),
    );
  }

  // The teardown half. A run that stops at 8s and exits at 88s is, to a harness
  // that bounds by wall-clock, a run that never stopped.
  check(
    "it exits promptly after the deadline, not eventually",
    run.elapsedSec < BUDGET_SEC + EXIT_GRACE_SEC,
    `${run.elapsedSec.toFixed(1)}s vs budget ${BUDGET_SEC}s`,
  );
} finally {
  server.kill("SIGKILL");
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
