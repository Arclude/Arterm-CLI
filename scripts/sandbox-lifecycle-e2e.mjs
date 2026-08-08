#!/usr/bin/env node
/**
 * Does a sandboxed run EXIT when it is finished?
 *
 * Nothing in `pnpm test` can answer that. The bug this exists for produced a
 * perfect run: `arterm --print --json --autonomous` did the work, wrote the
 * file, passed its verify gate, printed the JSON document with its verdict and
 * its usage — and then sat there forever, because the sandbox runtime's
 * host-side egress proxy and socket bridge were still listening and nothing
 * ever tore them down. Every in-process assertion passed. The caller saw a run
 * that never returned, and in CI that is a failed run whatever it accomplished.
 *
 * The property is one line — the process ends on its own — and it is only
 * observable from OUTSIDE the process, which is why this is a script and not a
 * vitest file. Same reason `provider-resilience-e2e.mjs` exists: an unref'd
 * backoff timer once let the CLI exit 0 mid-retry, the mirror image of this.
 *
 *   node scripts/sandbox-lifecycle-e2e.mjs
 *
 * Run it after a build — it drives the built binary. It skips (exit 0, loudly)
 * where the sandbox cannot be established at all, because "no bubblewrap on
 * this host" is not this assertion failing.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ARTERM = join(HERE, "..", "packages", "cli", "dist", "main.js");
const FAKE = join(HERE, "fault-server.mjs");
const PORT = 8137;

/**
 * How long a finished run is given to disappear.
 *
 * Generous on purpose: this must fail on "never exits", not on "exited slowly
 * on a loaded machine". The bug it catches is unbounded — the observed run was
 * still alive fifteen minutes in — so any finite ceiling separates the two.
 */
const EXIT_BUDGET_MS = 60_000;

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Run the built binary to completion, or report that it had to be killed. */
function runArterm(extraArgs) {
  const home = mkdtempSync(join(tmpdir(), "arterm-sandbox-e2e-"));
  mkdirSync(join(home, ".arterm"), { recursive: true });
  // Pin the host in the config as well as the environment: the CLI persists its
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
      [ARTERM, "--print", "--json", "--yolo", ...extraArgs, "--goal", "say hi"],
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
    const hammer = setTimeout(() => {
      killed = true;
      child.kill("SIGKILL");
    }, EXIT_BUDGET_MS);
    child.on("close", (code) => {
      clearTimeout(hammer);
      resolve({ code, stdout, stderr, killed, elapsed: Date.now() - started });
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
  // The control. It shares every code path with the sandboxed run except the
  // boundary, so if THIS one hangs the finding is something else entirely and
  // the sandboxed result below would be misread.
  const plain = await runArterm(["--no-sandbox"]);
  check(
    "unsandboxed run exits on its own",
    !plain.killed && plain.code === 0,
    `exit=${plain.code} killed=${plain.killed} ${plain.elapsed}ms`,
  );

  const boxed = await runArterm(["--sandbox"]);
  const unavailable = /sandbox could not be established|sandboxing is not supported/.test(
    boxed.stderr,
  );
  if (unavailable) {
    console.log("⊘ sandbox cannot be established on this host — skipping the assertion");
    console.log(`  ${boxed.stderr.trim().split("\n")[0]}`);
  } else {
    // THE regression. A hang shows up as killed=true; nothing else about the run
    // would have looked wrong.
    check(
      "sandboxed run exits on its own",
      !boxed.killed && boxed.code === 0,
      `exit=${boxed.code} killed=${boxed.killed} ${boxed.elapsed}ms`,
    );
    // And it did the work before exiting — otherwise "exits promptly" would be
    // satisfied by a run that crashed at boot.
    let doc;
    try {
      doc = JSON.parse(boxed.stdout);
    } catch {
      doc = undefined;
    }
    check(
      "sandboxed run still produced its result document",
      doc?.state !== undefined,
      doc ? `state=${doc.state}` : `stdout=${JSON.stringify(boxed.stdout.slice(0, 200))}`,
    );
  }
} finally {
  server.kill();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length > 0 ? 1 : 0);
