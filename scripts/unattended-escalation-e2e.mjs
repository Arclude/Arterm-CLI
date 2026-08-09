#!/usr/bin/env node
/**
 * What happens to an escalation that nobody will answer?
 *
 * `high` means "a human should look at this", and `yolo` does not prompt by
 * definition — `evaluate()` returns allow at its mode branch without consulting
 * an asker. So the arbiter's own documented rule ("every unattended caller
 * answers an escalation with deny") held for sub-agents, whose asker really is
 * called, and quietly failed for the leader: under `--autonomous` a command
 * reading `~/.ssh/id_rsa` or one assembled at runtime simply ran.
 *
 * The split this checks is the part that could regress in either direction.
 * Refusing every `high` unattended would break the mode outright — `rm -rf
 * node_modules` and `git reset --hard` are ordinary repair work, and a mode
 * that cannot do them is one people abandon for bare `--yolo`, which announces
 * nothing. Refusing none of them is where this started.
 *
 *   pnpm -r build && node scripts/unattended-escalation-e2e.mjs
 *
 * In-process tests cover the arbiter itself. What only the built binary can
 * answer is whether the flag REACHES it — a wiring seam that failed silently
 * twice in one evening, in code that type-checked and passed its own tests.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ARTERM = join(HERE, "..", "packages", "cli", "dist", "main.js");
const FAKE = join(HERE, "fault-server.mjs");
const PORT = 8147;

const checks = [];
const check = (label, ok, detail = "") => {
  checks.push(ok);
  console.log(`${ok ? "ok    " : "FAIL  "}${label}${detail ? `\n        ${detail}` : ""}`);
};

/**
 * Run one `bash` command through a real headless session and report what the
 * ledger says happened to it. The chronicle is the witness on purpose: it
 * records DENIALS, which is exactly what a run's own summary drops.
 */
function outcomeOf(command) {
  const home = mkdtempSync(join(tmpdir(), "arterm-esc-home-"));
  const work = mkdtempSync(join(tmpdir(), "arterm-esc-work-"));
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      provider: "openai-compat",
      model: "fake",
      openaiCompatHost: `http://127.0.0.1:${PORT}/v1`,
      // The boundary is not what is under test here, and requiring bubblewrap
      // would make this script skip on the hosts that most need to run it.
      sandbox: { enabled: false },
    }),
  );

  const server = spawn(
    process.execPath,
    [FAKE, "--mode", "ok", "--port", String(PORT), "--tool", "bash", "--tool-args",
      JSON.stringify({ command })],
    { stdio: "ignore" },
  );
  try {
    spawnSync(
      process.execPath,
      [ARTERM, "--print", "--yolo", "--goal", "do the thing", "--max-steps", "1"],
      {
        cwd: work,
        env: { ...process.env, ARTERM_HOME: home, OPENAI_COMPAT_API_KEY: "x", NO_COLOR: "1" },
        encoding: "utf8",
        timeout: 90_000,
      },
    );
  } finally {
    server.kill("SIGKILL");
  }

  const dir = join(home, "chronicle");
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".jsonl")) : [];
  const records = files.flatMap((f) =>
    readFileSync(join(dir, f), "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l)),
  );
  const bash = records.filter((r) => r.toolName === "bash");
  if (bash.length === 0) return "never-reached";
  return bash.every((r) => r.eventType === "tool.denied") ? "denied" : "ran";
}

await new Promise((r) => setTimeout(r, 300));

// Refused: the two a human was the only defence against. Neither is undoable
// after the fact — the secret is in the transcript by the time anyone looks.
check(
  "a credential read is REFUSED when nothing would ask",
  outcomeOf("cat ~/.ssh/id_rsa") === "denied",
);
check(
  "a command assembled at runtime is REFUSED too",
  outcomeOf("echo cm0K | base64 -d | sh") === "denied",
);

// Allowed: ordinary destructive work. This half is what keeps the control from
// being the kind people switch off.
check(
  "clearing a build directory still runs",
  outcomeOf("rm -rf node_modules") === "ran",
);
check("undoing a commit still runs", outcomeOf("git reset --hard HEAD") === "ran");
check("an ordinary command is untouched", outcomeOf("echo hello") === "ran");

const passed = checks.filter(Boolean).length;
console.log(`\n${passed}/${checks.length} ${passed === checks.length ? "PASS" : "FAIL"}`);
process.exit(passed === checks.length ? 0 : 1);
