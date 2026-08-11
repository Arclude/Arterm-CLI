import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PRE_TOOL_TIMEOUT_MS,
  hasAnyHook,
  hookToolCall,
  hooksSuppressed,
  runGateHook,
} from "./hooks.js";
import type { ToolCallCtx } from "./kernel/pipeline.js";

const dir = mkdtempSync(join(tmpdir(), "arterm-hooks-"));

/** Writes a shell script and returns a command line that runs it. */
function script(name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return path;
}

function ctx(): { cwd: string } {
  return { cwd: dir };
}

function callCtx(name: string, args: unknown): ToolCallCtx {
  return { call: { id: "c1", name, arguments: args as Record<string, unknown> } } as ToolCallCtx;
}

describe("the pre_tool gate", () => {
  it("blocks on exit 2 and hands the model the hook's own words", async () => {
    // The reason is stderr rather than a fixed string because the model READS
    // it: "blocked: writes to /etc are not allowed" is something it can adapt
    // to, and "blocked" is not.
    const cmd = script("deny.sh", 'echo "not on my watch" >&2\nexit 2');
    const verdict = await runGateHook(cmd, "write", { file_path: "/etc/passwd" }, ctx());
    expect(verdict.blocked).toBe(true);
    expect(verdict.reason).toBe("not on my watch");
  });

  it("falls OPEN on every other exit code", async () => {
    // 1 is what a careless script returns from a failing `grep`, and treating it
    // as a denial would turn a typo into a session that can run no tools at all.
    for (const code of [0, 1, 3, 127]) {
      const cmd = script(`exit${code}.sh`, `exit ${code}`);
      const verdict = await runGateHook(cmd, "bash", {}, ctx());
      expect(verdict.blocked, `exit ${code}`).toBe(false);
    }
  });

  it("falls open when the hook does not exist, and says nothing about it", async () => {
    const verdict = await runGateHook(join(dir, "no-such-hook"), "bash", {}, ctx());
    expect(verdict.blocked).toBe(false);
  });

  it("falls open when the hook hangs, rather than holding the turn", async () => {
    // A gate that never answers is a gate that is not there. Blocking here would
    // make one slow script indistinguishable from a hung agent.
    const cmd = script("hang.sh", "sleep 30");
    const started = Date.now();
    const verdict = await runGateHook(cmd, "bash", {}, ctx(), 300);
    expect(verdict.blocked).toBe(false);
    expect(Date.now() - started).toBeLessThan(DEFAULT_PRE_TOOL_TIMEOUT_MS);
  });

  it("hands the tool name and the FULL input on stdin", async () => {
    // The env copy is capped at 16 KB and a `write` call is routinely larger, so
    // stdin is the channel that carries the whole thing. Proven with an argument
    // past the cap: a gate that only read the variable would see a clipped one.
    const out = join(dir, "seen.txt");
    const cmd = script("capture.sh", `{ echo "$ARTERM_HOOK_TOOL_NAME"; cat; } > ${out}`);
    const big = "x".repeat(20_000);
    await runGateHook(cmd, "write", { body: big }, ctx());
    const seen = (await import("node:fs")).readFileSync(out, "utf8");
    expect(seen.split("\n")[0]).toBe("write");
    expect(seen).toContain(big);
  });

  it("withholds the session's credentials, and marks the recursion guard", async () => {
    // A hook is a spawned command, so it is the same door `bash` was: the keys
    // the user gave to Arterm must not be in the environment it inherits.
    // `ARTERM_HOOKS_DISABLED` is what lets a hook call `arterm` at all.
    process.env.ANTHROPIC_API_KEY = "sk-should-not-appear";
    const { readFileSync } = await import("node:fs");
    const out = join(dir, "env.txt");
    const cmd = script("env.sh", `env > ${out}`);
    await runGateHook(cmd, "bash", {}, ctx());
    const seen = readFileSync(out, "utf8");
    expect(seen).not.toContain("sk-should-not-appear");
    expect(seen).toContain("ARTERM_HOOKS_DISABLED=1");
    expect(seen).toContain("ARTERM_HOOK_EVENT=pre_tool");

    // The anchor. "The key is absent" is equally true of a hook that never ran,
    // of an `env` that wrote nothing, and of a variable that was never set —
    // so the same probe must SHOW the key when scrubbing is switched off.
    await runGateHook(cmd, "bash", {}, { ...ctx(), credentials: { scrub: false } });
    expect(readFileSync(out, "utf8")).toContain("sk-should-not-appear");
    process.env.ANTHROPIC_API_KEY = undefined;
  });
});

describe("the toolCall middleware", () => {
  it("a blocked call never reaches the tool, and reports as an error", async () => {
    const mw = hookToolCall({ preTool: script("no.sh", "echo nope >&2\nexit 2") }, ctx);
    const c = callCtx("bash", { command: "rm -rf /" });
    let ran = false;
    await mw(c, async () => {
      ran = true;
    });
    expect(ran).toBe(false);
    expect(c.isError).toBe(true);
    expect(c.output).toBe("nope");
  });

  it("an allowed call runs untouched", async () => {
    const mw = hookToolCall({ preTool: script("yes.sh", "exit 0") }, ctx);
    const c = callCtx("read", { path: "x" });
    let ran = false;
    await mw(c, async () => {
      ran = true;
      c.output = "contents";
    });
    expect(ran).toBe(true);
    expect(c.isError).toBeUndefined();
    expect(c.output).toBe("contents");
  });

  it("with no hooks configured it is never installed at all", () => {
    // The hot path pays nothing for a feature nobody turned on: the caller asks
    // this before building any payload, and before registering the stage.
    expect(hasAnyHook(undefined)).toBe(false);
    expect(hasAnyHook({})).toBe(false);
    expect(hasAnyHook({ preTool: "   " })).toBe(false);
    expect(hasAnyHook({ turnEnd: "notify-send hi" })).toBe(true);
  });

  it("knows when it is running inside a hook", () => {
    expect(hooksSuppressed({ ARTERM_HOOKS_DISABLED: "1" } as NodeJS.ProcessEnv)).toBe(true);
    expect(hooksSuppressed({} as NodeJS.ProcessEnv)).toBe(false);
  });
});
