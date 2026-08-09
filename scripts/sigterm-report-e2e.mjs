#!/usr/bin/env node
/**
 * Does a KILLED run still report what it did?
 *
 * The bug this exists for cost a real benchmark trial. Harbor bounds every task
 * by wall-clock and kills the process when it expires; the trial's
 * `arterm-result.json` came back **0 bytes**, so fifteen minutes of paid work
 * produced no token count, no cost and no partial summary — a row
 * indistinguishable from a run that never started. Every in-process assertion
 * passed, because in-process is exactly where the evidence was missing.
 *
 * `--max-duration` is the half that stops the run in time. This is the half for
 * when something stops us anyway, and it is only observable from OUTSIDE the
 * process: a vitest case cannot send itself SIGTERM and then assert on what its
 * own stdout contained after `process.exit`. Same reason
 * `sandbox-lifecycle-e2e.mjs` and `provider-resilience-e2e.mjs` are scripts.
 *
 *   node scripts/sigterm-report-e2e.mjs
 *
 * Run it after a build — it drives the built binary against the fake model, so
 * it needs no API key and calls nothing real.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ARTERM = join(HERE, "..", "packages", "cli", "dist", "main.js");
const FAKE = join(HERE, "fault-server.mjs");
const PORT = 8143;

/** How long the run is given to die and flush after the signal. */
const FLUSH_BUDGET_MS = 15_000;

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Start a run, wait until it is demonstrably WORKING, then signal it.
 *
 * Signalling on a timer alone would be a race that passes for the wrong reason:
 * a signal delivered before the first request produces an empty report that
 * still parses. So the trigger is the first `▸ step` on stderr — proof the loop
 * is under way and there is something to lose.
 */
function runAndSignal(signal) {
  const home = mkdtempSync(join(tmpdir(), "arterm-sigterm-e2e-"));
  mkdirSync(join(home, ".arterm"), { recursive: true });
  // Pin the host in config as well as the environment: the CLI persists its
  // whole config on exit, and a stale saved host silently redirects the next
  // run away from the fake server.
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
    const child = spawn(
      process.execPath,
      [
        ARTERM,
        "--print",
        "--json",
        "--yolo",
        "--no-sandbox",
        "--autonomy-mode",
        "eternal",
        "--max-steps",
        "500",
        "--goal",
        "keep working indefinitely",
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
    let signalled = false;
    let killed = false;
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
      if (!signalled && /▸ step/.test(stderr)) {
        signalled = true;
        child.kill(signal);
      }
    });
    // Belt and braces: if the run never reaches a step, signal anyway so the
    // script reports a real failure instead of hanging.
    const fallback = setTimeout(() => {
      if (!signalled) {
        signalled = true;
        child.kill(signal);
      }
    }, 20_000);
    const hammer = setTimeout(() => {
      killed = true;
      child.kill("SIGKILL");
    }, 20_000 + FLUSH_BUDGET_MS);
    child.on("close", (code) => {
      clearTimeout(fallback);
      clearTimeout(hammer);
      resolve({ code, stdout, stderr, killed });
    });
  });
}

const results = [];
function check(name, ok, note) {
  results.push({ name, ok, note });
  console.log(`${ok ? "✓" : "✗"} ${name}${note ? `  — ${note}` : ""}`);
}

const server = spawn(process.execPath, [FAKE, "--mode", "ok", "--port", String(PORT)], {
  stdio: "ignore",
});
await delay(700);

try {
  const run = await runAndSignal("SIGTERM");

  check("the signalled run exits rather than hanging", !run.killed, `exit=${run.code}`);

  // The whole point. Before this, stdout was empty and the file was 0 bytes.
  check("it wrote something to stdout at all", run.stdout.trim().length > 0, `${run.stdout.length}B`);

  let doc;
  try {
    doc = JSON.parse(run.stdout);
  } catch (err) {
    check("stdout parses as the result document", false, String(err).slice(0, 120));
  }

  if (doc) {
    check("stdout parses as the result document", true, `state=${doc.state}`);
    check(
      "it reports being terminated, not finished",
      doc.state === "stopped" && /terminated by SIGTERM/.test(doc.summary ?? ""),
      JSON.stringify(doc.summary ?? "").slice(0, 90),
    );
    // A partial report whose usage block is absent would leave the same hole
    // the 0-byte file left: spend that happened and was never accounted.
    check(
      "the usage block survived the signal",
      doc.usage !== undefined && typeof doc.usage.totalTokens === "number",
      `totalTokens=${doc.usage?.totalTokens} reported=${doc.usage?.reported}`,
    );
    check(
      "it says how far it got",
      typeof doc.steps === "number" && doc.steps >= 1,
      `steps=${doc.steps}`,
    );
  }

  // 128+signal is the shell's convention for "died of this signal"; a 0 here
  // would claim the run finished.
  check("it exits 143, not 0", run.code === 143, `exit=${run.code}`);
} finally {
  server.kill("SIGKILL");
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
