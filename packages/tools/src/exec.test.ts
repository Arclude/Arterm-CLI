import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProcessRegistry, assessRisk } from "@arterm/core";
import type { Tool } from "@arterm/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bashTool } from "./bash.js";
import { allowedCommands, createExecTool } from "./exec.js";
import { rmWithRetry } from "./testTmp.js";

let dir: string;
let registry: ProcessRegistry;
const exec = () => createExecTool({ registry });
const ctx = () => ({ cwd: dir, processes: registry });

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), "arterm-exec-"));
  registry = new ProcessRegistry();
});
afterEach(async () => {
  registry.killAll("SIGKILL");
  // A signal is a request, not an exit. Windows refuses to delete a directory a
  // live child still holds — `EBUSY: resource busy or locked, rmdir …` — which
  // fails a test whose own assertions all passed. POSIX deletes it regardless,
  // which is why four background tests were green everywhere but Windows.
  // Waiting for the registry to settle is the part `killAll` cannot do itself.
  await until(() => registry.live().length === 0).catch(() => {});
  await rmWithRetry(dir);
});

/** Wait for a predicate, so nothing depends on a fixed sleep. */
async function until(pred: () => boolean, ms = 5_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("condition not met");
}

describe("the allowlist", () => {
  it("contains a development toolchain", () => {
    const allowed = allowedCommands();
    for (const name of ["node", "pnpm", "git", "python3", "cargo", "go", "make"]) {
      expect(allowed.has(name), name).toBe(true);
    }
  });

  it("contains NO shell or shell-like dispatcher", () => {
    // Every one of these is a way to run something not on the list, which
    // would make the list decoration.
    const allowed = allowedCommands();
    for (const name of ["sh", "bash", "zsh", "fish", "env", "xargs", "nohup", "setsid", "ssh"]) {
      expect(allowed.has(name), `${name} must not be exec-able`).toBe(false);
    }
  });

  it("extends from config", () => {
    expect(allowedCommands(["mytool"]).has("mytool")).toBe(true);
  });
});

describe("execTool", () => {
  it("runs an allowed program and returns its output", async () => {
    const res = await exec().execute({ command: "node", args: ["-e", "console.log('hi')"] }, ctx());
    expect(res.isError).toBeFalsy();
    expect(res.output.trim()).toBe("hi");
  });

  it("passes arguments through UNINTERPRETED — there is no shell", async () => {
    // The whole point: `$(id)`, `|`, `>` and a space in a path are characters.
    const res = await exec().execute(
      { command: "node", args: ["-e", "console.log(process.argv[1])", "$(id) | tee /tmp/x > y"] },
      ctx(),
    );
    expect(res.output.trim()).toBe("$(id) | tee /tmp/x > y");
  });

  it("refuses a program that is not on the allowlist", async () => {
    const res = await exec().execute({ command: "sh", args: ["-c", "echo hi"] }, ctx());
    expect(res.isError).toBe(true);
    expect(res.output).toContain("not in exec's allowlist");
  });

  it("refuses a PATH, not just an unlisted name", async () => {
    // Otherwise the allowlist is about the last segment of anything on disk.
    const res = await exec().execute({ command: "/bin/sh", args: [] }, ctx());
    expect(res.isError).toBe(true);
    expect(res.output).toContain("not a path");
  });

  it("reports a non-zero exit as an error, with the output", async () => {
    const res = await exec().execute(
      { command: "node", args: ["-e", "console.log('before'); process.exit(3)"] },
      ctx(),
    );
    expect(res.isError).toBe(true);
    expect(res.output).toContain("before");
    expect(res.output).toContain("exit code 3");
  });

  it("times out rather than hanging the turn", async () => {
    const res = await exec().execute(
      { command: "node", args: ["-e", "setTimeout(() => {}, 60000)"], timeout_ms: 300 },
      ctx(),
    );
    expect(res.isError).toBe(true);
    expect(res.output).toContain("timed out");
  });

  it("withholds credential-named variables like every other spawn", async () => {
    process.env.ARTERM_TEST_API_KEY = "sk-leaked";
    try {
      const res = await exec().execute(
        {
          command: "node",
          args: ["-e", "console.log(process.env.ARTERM_TEST_API_KEY ?? 'absent')"],
        },
        ctx(),
      );
      expect(res.output.trim()).toBe("absent");
    } finally {
      Reflect.deleteProperty(process.env, "ARTERM_TEST_API_KEY");
    }
  });
});

describe("background execution", () => {
  it("returns an id at once and keeps running", async () => {
    const res = await exec().execute(
      { command: "node", args: ["-e", "setInterval(() => {}, 1000)"], background: true },
      ctx(),
    );
    expect(res.isError).toBeFalsy();
    expect(res.output).toMatch(/Started p1 \(pid \d+\)/);
    expect(registry.live()).toHaveLength(1);
  });

  it("collects the process's output into the registry", async () => {
    const res = await exec().execute(
      { command: "node", args: ["-e", "console.log('from the background')"], background: true },
      ctx(),
    );
    const id = /Started (p\d+)/.exec(res.output)?.[1] as string;
    await until(() => (registry.get(id)?.output ?? "").includes("from the background"));
    await until(() => registry.get(id)?.state === "exited");
    expect(registry.get(id)?.exitCode).toBe(0);
  });

  it("records the USER's argv, not the sandbox wrapper's", async () => {
    const res = await exec().execute(
      { command: "node", args: ["-e", "setInterval(()=>{},1000)"], background: true },
      { ...ctx(), sandbox: fakeSandbox() },
    );
    const id = /Started (p\d+)/.exec(res.output)?.[1] as string;
    // A `/ps` row naming the boundary instead of the process is useless.
    expect(registry.get(id)?.label).toContain("node");
    expect(registry.get(id)?.label).not.toContain("bwrap");
  });

  it("killAll stops what the session started", async () => {
    await exec().execute(
      { command: "node", args: ["-e", "setInterval(() => {}, 1000)"], background: true },
      ctx(),
    );
    expect(registry.killAll()).toBe(1);
    expect(registry.live()).toHaveLength(0);
  });

  it("refuses to background when there is no registry to record it in", async () => {
    // An unregistered background process is the leak this feature would BE.
    const res = await bashTool.execute({ command: "sleep 60", background: true }, { cwd: dir });
    expect(res.isError).toBe(true);
    expect(res.output).toContain("no process registry");
  });

  it("bash can background too, with a redacted label", async () => {
    const res = await bashTool.execute(
      { command: "node -e 'setInterval(()=>{},1000)' --token sk-real", background: true },
      ctx(),
    );
    expect(res.isError).toBeFalsy();
    const id = /Started (p\d+)/.exec(res.output)?.[1] as string;
    expect(registry.get(id)?.label).not.toContain("sk-real");
    expect(registry.get(id)?.label).toContain("«redacted»");
  });
});

describe("the arbiter sees exec's argv, not just its command word", () => {
  const tool = (name: string): Tool =>
    ({ name, category: "execute", parameters: {}, permission: "ask" }) as unknown as Tool;

  it("grades a hidden payload the same as its bash equivalent", () => {
    // Without this, `exec` would be the bypass for the control it improves on:
    // reading only `command` grades this call as the word "node".
    const viaBash = assessRisk(tool("bash"), {
      command: "echo cm0gLXJmIC8K | base64 -d | sh",
    });
    const viaExec = assessRisk(tool("exec"), {
      command: "sh",
      args: ["-c", "echo cm0gLXJmIC8K | base64 -d | sh"],
    });
    expect(viaBash.level).not.toBe("low");
    expect(viaExec.level).toBe(viaBash.level);
  });

  it("catches a destructive command split across argv", () => {
    const risk = assessRisk(tool("exec"), { command: "rm", args: ["-rf", "/"] });
    expect(risk.level).toBe("critical");
  });

  it("still reads bash's single command string", () => {
    expect(assessRisk(tool("bash"), { command: "rm -rf /" }).level).toBe("critical");
  });

  it("leaves an ordinary call where bash would leave it", () => {
    // `medium` and not `low`: the command lists are DENY-lists, so what they do
    // not recognise is graded medium and runs unprompted under auto/yolo. The
    // point here is only that joining argv did not invent an escalation.
    const viaExec = assessRisk(tool("exec"), { command: "node", args: ["--version"] });
    expect(viaExec.level).toBe(assessRisk(tool("bash"), { command: "node --version" }).level);
    expect(viaExec.level).toBe("medium");
  });
});

/** A boundary that just rewrites argv, enough to prove which one is recorded. */
function fakeSandbox() {
  return {
    describe: "fake",
    async wrap(command: string) {
      return {
        argv: ["node", "-e", "setInterval(()=>{},1000)"],
        env: { ...process.env, BWRAP: command.slice(0, 0) },
      };
    },
    release() {},
  };
}
