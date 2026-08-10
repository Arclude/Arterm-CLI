#!/usr/bin/env node
/**
 * Does a real run record what a SHELL command wrote?
 *
 * The chronicle's evidence comes from `ToolResult.path`, which every writing
 * tool declares — and `bash` cannot, because it runs a string and does not know
 * what the string touched. So a run doing its work through the shell recorded
 * nothing, and the judge reads that ledger against the claim: an empty one says
 * "this run wrote nothing", which is the reading that let a rewritten `slug()`
 * pass as `docs(…)`.
 *
 * The watcher that closes it has unit tests on both sides — `workspaceWatch`
 * against a real repository, and the pipeline stage against a fake watcher. The
 * seam between them has none, and it is a seam with a documented history of
 * failing silently: the gate reading `ctx.tool` looked right and never opened,
 * because the permission stage sets that field AFTER the ledger stage runs.
 * Nothing in-process could see it. This drives the built binary end to end and
 * reads the JSONL off disk.
 *
 *   pnpm -r build && node scripts/shell-writes-recorded-e2e.mjs
 *
 * No API key and no real model: the fake server answers every request with one
 * `bash` tool call, which is the whole point — the file must appear in the
 * ledger without any tool having declared it.
 */
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ARTERM = join(HERE, "..", "packages", "cli", "dist", "main.js");
const FAKE = join(HERE, "fault-server.mjs");
const PORT = 8143;
// TWO files from ONE command, which is the shape a single `change` field
// cannot hold and the reason the per-file records are their own events.
const WROTE = ["made-by-the-shell.txt", "also-by-the-shell.txt"];

const home = mkdtempSync(join(tmpdir(), "arterm-shellwrite-home-"));
const work = mkdtempSync(join(tmpdir(), "arterm-shellwrite-work-"));

// A second session, alive for the whole run and working in the same tree.
//
// The watcher cannot say WHO wrote a file, so it records who else could have —
// and the case it was built for is this one, because several agents run at
// once here. A live pid plus a discovery file is all that makes a peer real to
// `peerSessions`, and a `sleep` gives both without a second model.
const peer = spawn("sleep", ["120"], { stdio: "ignore" });
mkdirSync(join(home, "status"), { recursive: true });
writeFileSync(
  join(home, "status", `${peer.pid}-peer.json`),
  JSON.stringify({ v: 1, pid: peer.pid, sessionId: "peer", cwd: work, model: "peer-model" }),
);

// A real repository, because git IS the watcher's candidate set — outside one
// there is nothing to watch, which is a stated scope limit and would make this
// script pass by doing nothing at all.
const git = (...args) => spawnSync("git", args, { cwd: work, stdio: "pipe", encoding: "utf8" });
git("init", "-q");
git("config", "user.email", "t@example.com");
git("config", "user.name", "t");
writeFileSync(join(work, "README.md"), "base\n");
git("add", "-A");
git("commit", "-qm", "base");

// The host must be pinned in the sandbox HOME's config: the CLI persists the
// whole config on exit, and a stale saved host silently redirects the next run
// away from the fake server — zero requests and an instant provider error.
writeFileSync(
  join(home, "config.json"),
  JSON.stringify({
    provider: "openai-compat",
    model: "fake",
    openaiCompatHost: `http://127.0.0.1:${PORT}/v1`,
    permissions: { mode: "yolo" },
    sandbox: { enabled: false },
  }),
);

const server = spawn(
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
    JSON.stringify({
      command: WROTE.map((f) => `printf 'written by a command\\n' > ${f}`).join(" && "),
    }),
  ],
  { stdio: "ignore" },
);

const done = (code) => {
  server.kill("SIGKILL");
  peer.kill("SIGKILL");
  process.exit(code);
};

await new Promise((r) => setTimeout(r, 700));

const run = spawnSync(
  process.execPath,
  // `--yolo` because the headless asker answers an unattended prompt with
  // "deny": without it every `bash` call is refused and the ledger records
  // eight denials, which is a fine record of nothing having been written.
  [
    ARTERM,
    "--print",
    "--yolo",
    "--goal",
    "write the file with a shell command",
    "--max-steps",
    "2",
  ],
  {
    cwd: work,
    env: { ...process.env, ARTERM_HOME: home, OPENAI_COMPAT_API_KEY: "x", NO_COLOR: "1" },
    encoding: "utf8",
    timeout: 90_000,
  },
);

const checks = [];
const check = (label, ok, detail = "") => {
  checks.push(ok);
  console.log(`${ok ? "ok    " : "FAIL  "}${label}${detail ? `\n        ${detail}` : ""}`);
};

check(
  "the command actually ran",
  WROTE.every((f) => existsSync(join(work, f))),
  `${run.stdout ?? ""}`.slice(-200),
);

const dir = join(home, "chronicle");
const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".jsonl")) : [];
const records = files.flatMap((f) =>
  readFileSync(join(dir, f), "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l)),
);
check("the ledger was written at all", records.length > 0, `${records.length} record(s)`);

const observed = records.filter((r) => r.eventType === "file.observed");
const hit = observed.find((r) => r.change?.path === WROTE[0]);
check(
  "the shell's writes are IN the ledger, declared by nobody",
  WROTE.every((f) => observed.some((r) => r.change?.path === f)),
  hit ? JSON.stringify(hit.change) : `file.observed records: ${observed.length}`,
);
check(
  "its digest was read off the disk",
  /^[0-9a-f]{64}$/.test(hit?.change?.contentHashAfter ?? ""),
);
check("it is attributed to the call that caused it", hit?.toolName === "bash" && !!hit?.toolCallId);
check("the provenance says it was measured, not declared", hit?.attributes?.observedBy === "git");
// The doubt, bounded and named. Empty would be a finding too — but with a peer
// deliberately alive in the same tree, empty means the wiring never ran.
check(
  "the other session alive in this tree is named",
  Array.isArray(hit?.attributes?.concurrent) &&
    hit.attributes.concurrent.some((w) => w.includes(String(peer.pid))),
  JSON.stringify(hit?.attributes?.concurrent),
);

// One call is one execution however many files it wrote — the per-file records
// are separate events on purpose, and folding them in would inflate every count
// taken off the ledger. The fake model repeats itself until the loop detector
// cuts it, so `executed` is many while the writes are two: that gap is exactly
// the decoupling, and it also shows a repeat of the SAME write recording
// nothing, because the digest did not move.
const executed = records.filter((r) => r.eventType === "tool.executed" && r.toolName === "bash");
check(
  "files and executions are counted separately",
  executed.length > 1 && observed.length === WROTE.length,
  `${executed.length} execution(s), ${observed.length} observed file(s)`,
);

const verify = spawnSync(process.execPath, [ARTERM, "chronicle", "verify"], {
  cwd: work,
  env: { ...process.env, ARTERM_HOME: home, NO_COLOR: "1" },
  encoding: "utf8",
});
check(
  "the chain still verifies with the new records in it",
  verify.status === 0,
  `${verify.stdout ?? ""}${verify.stderr ?? ""}`.trim().slice(0, 160),
);

const passed = checks.filter(Boolean).length;
console.log(`\n${passed}/${checks.length} ${passed === checks.length ? "PASS" : "FAIL"}`);
done(passed === checks.length ? 0 : 1);
