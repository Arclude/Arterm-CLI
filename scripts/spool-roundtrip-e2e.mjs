#!/usr/bin/env node
/**
 * Can the model actually go back for a spooled tool result?
 *
 * Oversized output is clamped and written to disk with the path appended, and
 * for a long time `read` refused that path outright — the offload was
 * decorative, and every unit test passed while it was. The fix is covered at
 * both ends and at the seam, but all of that lives inside one package's source.
 * What nothing covers is the cross-package link in the SHIPPED artifacts:
 * `core`'s agent is what fills `ctx.spooled`, and `tools`' real `read` is what
 * has to honour it, after tsup has bundled both.
 *
 *   pnpm -r build && node scripts/spool-roundtrip-e2e.mjs
 *
 * No server and no model: a scripted provider calls `bash`, then reads the
 * `[full output: …]` path out of its own tool result, the way a model would.
 *
 * It also pins the part that surprised the author. `read` is PAGINATED, so a
 * spooled file does not come back whole — the first call returns a window and
 * says how many lines are below it, and the tail takes a second call with an
 * offset. That is the feature working, not failing, and a test asserting "the
 * whole file came back" would have reported a bug that is not there. A single
 * enormous LINE is the one shape this does not solve: `read` clips it and says
 * so, and `tail -c` through `bash` is the way out.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
process.env.ARTERM_HOME = mkdtempSync(join(tmpdir(), "arterm-spool2-"));

const { Agent, EventBus, PermissionManager } = await import(
  join(REPO, "packages", "core", "dist", "index.js")
);
const { defaultTools } = await import(join(REPO, "packages", "tools", "dist", "index.js"));

const tools = defaultTools();
const bash = tools.find((t) => t.name === "bash");
const read = tools.find((t) => t.name === "read");
if (!bash || !read) throw new Error("bash/read missing from the built roster");

const MARKER = "THE-TAIL-MARKER";
const announced = (s) => /\[full output: (.+?)\]/.exec(s ?? "")?.[1];

/** bash first; then `read` on whatever path the previous result announced. */
class ReadBack {
  id = "stub";
  supportsNativeTools() {
    return true;
  }
  async listModels() {
    return [];
  }
  async *chat(req) {
    const said = req.messages
      .flatMap((m) => (typeof m.content === "string" ? [m.content] : []))
      .map(announced)
      .find(Boolean);
    if (!said) {
      yield {
        type: "tool_call",
        call: {
          id: "c1",
          name: "bash",
          // Many lines, not one enormous one: `read` clips a long LINE (it says
          // so), and a single-line fixture would be testing that rule instead
          // of the round trip.
          arguments: { command: `seq 1 8000; echo ${MARKER}` },
        },
      };
    } else if (!this.readCalled) {
      this.readCalled = said;
      yield { type: "tool_call", call: { id: "c2", name: "read", arguments: { path: said } } };
    } else if (!this.pagedCalled) {
      // `read` is paginated and SAYS how much is below, so getting the tail is
      // a second call with an offset — which is the real question behind "can
      // the model go back for the rest".
      this.pagedCalled = true;
      yield {
        type: "tool_call",
        call: { id: "c3", name: "read", arguments: { path: said, offset: 7900 } },
      };
    } else {
      yield { type: "text", delta: "done" };
    }
    yield { type: "done" };
  }
}

const provider = new ReadBack();
const bus = new EventBus();
const results = [];
bus.on((e) => {
  if (e.type === "tool_result") results.push(e);
});

const agent = new Agent({
  provider,
  model: "m",
  tools,
  permissions: new PermissionManager({}, "yolo"),
  ask: async () => "allow",
  bus,
  cwd: mkdtempSync(join(tmpdir(), "arterm-spool2-work-")),
});
await agent.run("run it, then read the full output");

const checks = [];
const check = (label, ok, detail = "") => {
  checks.push(ok);
  console.log(`${ok ? "ok    " : "FAIL  "}${label}${detail ? `\n        ${detail}` : ""}`);
};

const spooled = announced(results[0]?.output);
check("the oversized output was spooled and the path announced", Boolean(spooled), spooled ?? "-");
check("the model then asked to read that exact path", provider.readCalled === spooled);
const readOut = results[1]?.output ?? "";
check(
  "`read` opened it instead of refusing it",
  !/escapes the working directory/i.test(readOut),
  readOut.slice(0, 100),
);
check("it says how much is left rather than stopping silently", /line\(s\) below/.test(readOut));
const pagedOut = results[2]?.output ?? "";
check("paging to the end reaches the tail", pagedOut.includes(MARKER), pagedOut.slice(-80));

const passed = checks.filter(Boolean).length;
console.log(`\n${passed}/${checks.length} ${passed === checks.length ? "PASS" : "FAIL"}`);
process.exit(passed === checks.length ? 0 : 1);
