#!/usr/bin/env node
/**
 * Can a sandboxed command still read Arterm's own key material?
 *
 * `credentials.ts` withholds credential-NAMED variables from what a command
 * inherits, and its argument for doing so is that the leak needs no egress: a
 * secret in a tool result travels out through Arterm's own request to the
 * model, which no allowlist is on the path of. That argument applies word for
 * word to `cat ~/.arterm/key ~/.arterm/secrets.json`, which collects what the
 * scrub held back and more — the keys `arterm auth set` stored were never in
 * the environment at all.
 *
 * The policy half is a unit test (`resolveSandbox` puts both files in
 * `denyRead`). This is the half no unit test reaches: whether bubblewrap acts
 * on the list. A denial the mechanism ignores is a green suite and an open
 * door, which is the same shape as the spool that told the model a path it
 * could not open.
 *
 *   pnpm -r build && node scripts/keystore-denyread-e2e.mjs
 *
 * It runs against a THROWAWAY `ARTERM_HOME` holding a sentinel string — the
 * developer's real keys are never the fixture — and skips loudly (exit 0)
 * where no sandbox can be established, because "no bubblewrap on this host" is
 * not this assertion failing.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SENTINEL = "sk-arterm-e2e-THIS-MUST-NOT-APPEAR";

const home = mkdtempSync(join(tmpdir(), "arterm-denyread-home-"));
process.env.ARTERM_HOME = home;
writeFileSync(join(home, "key"), `${SENTINEL}\n`);
writeFileSync(join(home, "secrets.json"), JSON.stringify({ anthropic: SENTINEL }));
// Spooled tool output lives under the same home and the model is handed the
// path on purpose — denying the DIRECTORY would break that, so it is asserted
// here beside the leak checks rather than left to be discovered later.
const spool = join(home, "tool-output");
mkdirSync(spool, { recursive: true });
writeFileSync(join(spool, "bash-1.txt"), "the spooled output the model is sent back for\n");

const { resolveSandbox } = await import(join(HERE, "..", "packages", "core", "dist", "index.js"));
const { createSandboxRunner } = await import(
  join(HERE, "..", "packages", "tools", "dist", "index.js")
);

const cwd = mkdtempSync(join(tmpdir(), "arterm-denyread-work-"));
const spec = resolveSandbox({ enabled: true }, { cwd });
console.log(`denyRead: ${spec.denyRead.join(", ")}\n`);

const established = await createSandboxRunner(spec);
if (!established.ok) {
  console.log(`SKIP — no sandbox on this host: ${established.reason}`);
  process.exit(0);
}
const runner = established.runner;

/** Run one command inside the boundary and return everything it emitted. */
async function inside(command) {
  const wrapped = await runner.wrap(command, cwd);
  const [bin, ...rest] = wrapped.argv;
  const r = spawnSync(bin, rest, { env: wrapped.env, cwd, encoding: "utf8" });
  runner.release();
  return `${r.stdout ?? ""}${r.stderr ?? ""}`;
}

const checks = [];
const leaks = async (label, command) => {
  const out = await inside(command);
  const leaked = out.includes(SENTINEL);
  checks.push(!leaked);
  console.log(`${leaked ? "LEAK  " : "ok    "}${label}\n        ${trim(out)}`);
};

function trim(s) {
  const line = s.replace(/\s+/g, " ").trim();
  return line.length > 100 ? `${line.slice(0, 100)}…` : line || "(no output)";
}

// Four spellings of one read. The last two never name the file at all, which
// is exactly what the arbiter's text screen cannot catch and why the answer
// has to come from the mechanism. Checked against the pre-fix build: 1/5, with
// the sentinel in all four.
await leaks("the master key, named directly", `cat ${join(home, "key")}`);
await leaks("the ciphertext beside it", `cat ${join(home, "secrets.json")}`);
await leaks("a glob over the whole home", `cat ${home}/* 2>/dev/null`);
await leaks("grep sweeping the home", `grep -r sk- ${home} 2>/dev/null`);

const spoolOut = await inside(`cat ${join(spool, "bash-1.txt")}`);
const spoolReadable = spoolOut.includes("spooled output");
checks.push(spoolReadable);
console.log(
  `${spoolReadable ? "ok    " : "BROKE "}the spool is still readable\n        ${trim(spoolOut)}`,
);

await runner.dispose?.();

const passed = checks.filter(Boolean).length;
console.log(`\n${passed}/${checks.length} ${passed === checks.length ? "PASS" : "FAIL"}`);
process.exit(passed === checks.length ? 0 : 1);
