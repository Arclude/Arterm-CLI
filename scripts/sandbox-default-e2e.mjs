#!/usr/bin/env node
/**
 * A session that configures NOTHING — is it confined?
 *
 * The sandbox became the default for attended sessions too, and a default is
 * exactly the kind of claim that is true in a unit test and false in the
 * product: `defaultConfig()` can say `enabled: true` while the flag layer, the
 * session builder or the tool never act on it. `config.test.ts` pins the value;
 * this pins the CONSEQUENCE, through the built binary, with a config file that
 * does not mention the sandbox at all.
 *
 * Run it after a build:
 *
 *     pnpm -r build && node scripts/sandbox-default-e2e.mjs
 *
 * Two runs, and the second is what makes the first mean anything. The
 * `--no-sandbox` run must ACHIEVE the escape and the key read; the default run
 * must refuse both. Without that anchor "the file was not written" is equally
 * true of a run where `bash` never executed — the failure this repo keeps
 * meeting (see the mention picker's "a git-ignored file is not offered", which
 * passed against a build with no picker on it).
 *
 * The probes need no network and never touch the real home:
 *   - inside  — a write into the session cwd, which must keep working, because
 *               a boundary that breaks ordinary work is one people switch off.
 *   - escape  — a write into this REPOSITORY, which is neither the cwd nor the
 *               OS temp dir, and so is outside every write root. It is cleaned
 *               up; if it survives the confined run, its existence IS the
 *               finding.
 *   - key     — `cat $ARTERM_HOME/key`, the denyRead floor. The file sits under
 *               the temp dir, i.e. INSIDE a write root, so it is denied by name
 *               and nothing else — which is the only reason this probe can tell
 *               the floor from the roots.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");
const ARTERM = join(REPO, "packages", "cli", "dist", "main.js");
const FAKE = join(HERE, "fault-server.mjs");
const PORT = 8147;
const ESCAPE = join(REPO, ".sandbox-escape-probe");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const read = (p) => {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
};

process.on("exit", () => rmSync(ESCAPE, { force: true }));

const checks = [];
const check = (label, ok, detail = "") => {
  checks.push(ok);
  console.log(`${ok ? "ok    " : "FAIL  "}${label}${detail ? `\n        ${detail}` : ""}`);
};

/**
 * One headless run whose single `bash` call fires all three probes.
 *
 * `;` between them, never `&&`: a refused write must not stop the ones after
 * it, or one denial would report as every probe having been prevented.
 */
async function run({ confined }) {
  const home = mkdtempSync(join(tmpdir(), "arterm-sbdefault-home-"));
  const work = mkdtempSync(join(tmpdir(), "arterm-sbdefault-work-"));
  // The key is NOT planted. A sentinel written here is overwritten by the
  // keystore's own master key at boot, so the probe compared the command's
  // capture against a string that no longer existed on either side and read as
  // "nothing leaked" in the run where everything did. The secret this asks
  // about is whatever `$ARTERM_HOME/key` holds AFTER the run, read from disk by
  // the harness — the one value both sides can be compared against.
  //
  // No `sandbox` key in the config at all: the whole point is that the DEFAULT
  // decides. The host is pinned because the CLI persists the config on exit,
  // and a stale saved host silently sends the next run somewhere else.
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      provider: "openai-compat",
      model: "fake",
      openaiCompatHost: `http://127.0.0.1:${PORT}/v1`,
    }),
  );

  const command = [
    "printf 'inside\\n' > inside.txt",
    `printf 'escaped\\n' > ${ESCAPE}`,
    `cat ${join(home, "key")} > key-read.txt 2>&1`,
  ].join(" ; ");

  const model = spawn(
    process.execPath,
    [
      FAKE,
      "--mode",
      "ok",
      "--port",
      String(PORT),
      "--tool",
      "bash",
      "--tool-args",
      JSON.stringify({ command }),
    ],
    { stdio: "ignore" },
  );
  await sleep(700);

  const started = Date.now();
  const proc = spawnSync(
    process.execPath,
    [
      ARTERM,
      "--print",
      // Headless answers an unattended prompt with "deny", so without yolo every
      // `bash` call is refused and all three probes come back "did not happen".
      "--yolo",
      ...(confined ? [] : ["--no-sandbox"]),
      "--goal",
      "run the shell command",
      "--max-steps",
      "2",
    ],
    {
      cwd: work,
      env: { ...process.env, ARTERM_HOME: home, OPENAI_COMPAT_API_KEY: "x", NO_COLOR: "1" },
      encoding: "utf8",
      timeout: 120_000,
    },
  );
  const ms = Date.now() - started;
  model.kill("SIGKILL");
  await sleep(300);

  const secret = read(join(home, "key")).trim();
  return {
    ms,
    out: `${proc.stdout ?? ""}${proc.stderr ?? ""}`,
    inside: existsSync(join(work, "inside.txt")),
    escaped: existsSync(ESCAPE),
    // An empty `secret` would make `includes("")` true for every run, which is
    // the shape of a probe that reports a leak it never observed.
    leaked: secret.length > 0 && read(join(work, "key-read.txt")).includes(secret),
    hasSecret: secret.length > 0,
  };
}

// ── the anchor: unconfined, every probe must SUCCEED ────────────────────────
// Run first, so a harness that cannot drive `bash` at all is caught here rather
// than being read as a boundary doing its job.
const open = await run({ confined: false });
check("--no-sandbox: the ordinary write happens", open.inside, open.out.slice(-200));
check("--no-sandbox: a write outside the project HAPPENS", open.escaped);
check(
  "--no-sandbox: the keystore is readable",
  open.leaked,
  open.hasSecret ? "the command captured it" : "no key on disk — the probe had nothing to leak",
);
rmSync(ESCAPE, { force: true });

// ── the claim: nothing configured, and the boundary is in force ─────────────
const shut = await run({ confined: true });
check("default: ordinary work still succeeds", shut.inside, shut.out.slice(-200));
check(
  "default: a write outside the project is REFUSED",
  !shut.escaped,
  "write roots are the session cwd and the OS temp dir, derived at boot",
);
check(
  "default: the keystore is NOT readable",
  !shut.leaked,
  "denyRead is a floor seeded from keystorePaths(), not a config default",
);

console.log(`\n(unconfined ${open.ms}ms · confined ${shut.ms}ms)`);
const passed = checks.filter(Boolean).length;
console.log(`${passed}/${checks.length} ${passed === checks.length ? "PASS" : "FAIL"}`);
process.exit(passed === checks.length ? 0 : 1);
