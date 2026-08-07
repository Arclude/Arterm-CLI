import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "@arterm/core";
import { describe, expect, it } from "vitest";
import { buildSession } from "./session.js";

/**
 * The promise that makes background execution safe to offer.
 *
 * Every unit test around this fakes the child, which proves the bookkeeping and
 * nothing about the machine. The only thing that matters to a user is whether a
 * dev server the agent launched is still holding a port after the session
 * closed — so this starts a real process, asks the kernel whether it is alive
 * (signal 0), tears the session down, and asks again.
 *
 * It also covers a seam nothing else does: `exec` is added by `buildSession`,
 * so no test in @arterm/tools can tell whether it reached the roster, and the
 * teardown lives in `persist()`, which is CLI-side.
 */
describe("a session stops what it started", () => {
  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  it("kills a real background process on teardown", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "arterm-ps-e2e-"));
    const { session, persist } = await buildSession({ config: defaultConfig(), cwd });

    const exec = session.agent.tools.find((t) => t.name === "exec");
    expect(exec, "exec must be on the session's roster").toBeDefined();

    const res = await exec?.execute(
      { command: "node", args: ["-e", "setInterval(() => {}, 1000)"], background: true },
      { cwd, processes: session.processes },
    );
    expect(res?.isError).toBeFalsy();

    const live = session.processes.live();
    expect(live).toHaveLength(1);
    const pid = live[0]?.pid as number;
    expect(alive(pid), "the process should be running").toBe(true);

    await persist();

    expect(session.processes.live()).toHaveLength(0);
    // SIGTERM is delivered asynchronously; poll rather than assume.
    for (let i = 0; i < 50 && alive(pid); i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(alive(pid), "the process should be gone after teardown").toBe(false);
  }, 30_000);
});
