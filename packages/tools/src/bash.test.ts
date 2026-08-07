import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxRunner } from "@arterm/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bashTool } from "./bash.js";

let dir: string;
const ctx = (extra?: { signal?: AbortSignal }) => ({ cwd: dir, ...extra });

/** Cross-platform command: `node -e "<js>"` works under cmd, PowerShell, and sh. */
const node = (js: string) => `node -e "${js}"`;

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), "arterm-bash-test-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("bashTool", () => {
  it("runs a command in the working directory and returns stdout", async () => {
    const res = await bashTool.execute({ command: node("console.log(process.cwd())") }, ctx());
    expect(res.isError).toBeFalsy();
    // Compare basenames — realpath vs symlinked tmpdir can differ on macOS/Windows.
    expect(res.output).toContain(dir.split(/[\\/]/).pop() as string);
  });

  it("reports a non-zero exit code as an error with the code attached", async () => {
    const res = await bashTool.execute({ command: node("process.exit(3)") }, ctx());
    expect(res.isError).toBe(true);
    expect(res.output).toContain("[exit code 3]");
  });

  it("captures stderr in the combined output", async () => {
    const res = await bashTool.execute(
      { command: node("console.error('oops'); process.exit(1)") },
      ctx(),
    );
    expect(res.isError).toBe(true);
    expect(res.output).toContain("oops");
  });

  it("kills a command that exceeds timeout_ms", async () => {
    const res = await bashTool.execute(
      { command: node("setTimeout(() => {}, 60000)"), timeout_ms: 300 },
      ctx(),
    );
    expect(res.isError).toBe(true);
  }, 15_000);

  it("is cancellable via the context signal", async () => {
    const controller = new AbortController();
    const pending = bashTool.execute(
      { command: node("setTimeout(() => {}, 60000)") },
      ctx({ signal: controller.signal }),
    );
    setTimeout(() => controller.abort(), 200);
    const res = await pending;
    expect(res.isError).toBe(true);
  }, 15_000);

  it.each([
    "rm -rf / --no-preserve-root",
    "rm -rf ~",
    "mkfs /dev/sda1",
    "dd if=/dev/zero of=/dev/sda",
    ":(){ :|:& };:",
    // Windows (cmd/PowerShell) — refused before ever reaching the shell.
    "format c:",
    "Format-Volume -DriveLetter C",
    "rmdir /s /q C:\\",
    "del /s /q C:\\*",
    "Remove-Item -Recurse -Force C:\\",
    "cipher /w:C:\\",
  ])("refuses dangerous pattern: %s", async (command) => {
    const res = await bashTool.execute({ command }, ctx());
    expect(res.isError).toBe(true);
    expect(res.output).toContain("refused");
  });

  it("errors cleanly when command is missing", async () => {
    const res = await bashTool.execute({}, ctx()).catch((err: Error) => ({
      output: err.message,
      isError: true,
    }));
    expect(res.isError).toBe(true);
  });
});

describe("bashTool env hygiene", () => {
  /** Print one variable, or the word "absent" — the whole assertion in one command. */
  const show = (name: string) => node(`console.log(process.env.${name} ?? 'absent')`);

  beforeEach(() => {
    process.env.ARTERM_TEST_API_KEY = "sk-leaked";
    process.env.ARTERM_TEST_PLAIN = "visible";
  });
  afterEach(() => {
    Reflect.deleteProperty(process.env, "ARTERM_TEST_API_KEY");
    Reflect.deleteProperty(process.env, "ARTERM_TEST_PLAIN");
  });

  it("withholds a credential-named variable from the command", async () => {
    const res = await bashTool.execute({ command: show("ARTERM_TEST_API_KEY") }, ctx());
    expect(res.output.trim()).toBe("absent");
  });

  it("passes the rest of the environment through untouched", async () => {
    const res = await bashTool.execute({ command: show("ARTERM_TEST_PLAIN") }, ctx());
    expect(res.output.trim()).toBe("visible");
    // PATH has to survive or nothing runs at all — the check that the scrub is
    // a filter and not a replacement.
    const path = await bashTool.execute({ command: show("PATH") }, ctx());
    expect(path.output.trim()).not.toBe("absent");
  });

  it("hands it over when the session switched the scrub off", async () => {
    const res = await bashTool.execute(
      { command: show("ARTERM_TEST_API_KEY") },
      { ...ctx(), credentials: { scrub: false } },
    );
    expect(res.output.trim()).toBe("sk-leaked");
  });

  it("honours an allowlisted name", async () => {
    const res = await bashTool.execute(
      { command: show("ARTERM_TEST_API_KEY") },
      { ...ctx(), credentials: { allow: ["ARTERM_TEST_API_KEY"] } },
    );
    expect(res.output.trim()).toBe("sk-leaked");
  });

  it("tells a FAILED command what was withheld, by name and never by value", async () => {
    const res = await bashTool.execute(
      { command: node("console.error('need ARTERM_TEST_API_KEY'); process.exit(3)") },
      ctx(),
    );
    expect(res.isError).toBe(true);
    expect(res.output).toContain("credentials.allow");
    expect(res.output).not.toContain("sk-leaked");
  });

  it("stays quiet on a failure that had nothing to do with the environment", async () => {
    const res = await bashTool.execute({ command: node("process.exit(3)") }, ctx());
    expect(res.isError).toBe(true);
    expect(res.output).not.toContain("credentials.allow");
  });

  it("says nothing on success — the note is a diagnosis, not a banner", async () => {
    const res = await bashTool.execute({ command: node("console.log('ok')") }, ctx());
    expect(res.output.trim()).toBe("ok");
  });
});

describe("bashTool inside a sandbox", () => {
  /** A boundary that just prefixes an env marker — enough to prove argv is used. */
  const fakeSandbox = (overrides?: Partial<SandboxRunner>): SandboxRunner => ({
    describe: "fake",
    async wrap(command) {
      return {
        argv: ["node", "-e", `process.env.INSIDE = "1"; ${stripNode(command)}`],
        env: { ...process.env, INSIDE: "1" },
      };
    },
    release() {},
    ...overrides,
  });

  /** Undo the test helper's `node -e "…"` so the fake can re-wrap the JS. */
  const stripNode = (cmd: string) => cmd.replace(/^node -e "(.*)"$/, "$1");

  it("runs the wrapped argv, not the raw command", async () => {
    const res = await bashTool.execute(
      { command: node("console.log(process.env.INSIDE ?? 'outside')") },
      { ...ctx(), sandbox: fakeSandbox() },
    );
    expect(res.isError).toBeFalsy();
    expect(res.output.trim()).toBe("1");
  });

  it("turns a refusal into an error result instead of running unconfined", async () => {
    const marker = join(dir, "escaped.txt");
    const res = await bashTool.execute(
      { command: node(`require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`) },
      {
        ...ctx(),
        sandbox: fakeSandbox({
          wrap: async () => {
            throw new Error("cwd is outside the sandbox boundary");
          },
        }),
      },
    );
    expect(res.isError).toBe(true);
    expect(res.output).toContain("Sandbox refused");
    // The whole point: a refused command did not run anyway.
    await expect(fs.access(marker)).rejects.toThrow();
  });

  it("scrubs the SANDBOXED path too, and keeps the wrapper's own variables", async () => {
    // The path that leaked before: execa merges `env` into `process.env` by
    // default, so handing it the wrapper's map passed the host's keys through
    // as well. `INSIDE` proves the wrapper's additions still arrive.
    process.env.ARTERM_TEST_API_KEY = "sk-leaked";
    try {
      const res = await bashTool.execute(
        {
          command: node(
            "console.log([process.env.INSIDE ?? 'no-wrap', process.env.ARTERM_TEST_API_KEY ?? 'absent'].join(' '))",
          ),
        },
        { ...ctx(), sandbox: fakeSandbox() },
      );
      expect(res.output.trim()).toBe("1 absent");
    } finally {
      Reflect.deleteProperty(process.env, "ARTERM_TEST_API_KEY");
    }
  });

  it("releases per-command state even when the command fails", async () => {
    let released = 0;
    await bashTool.execute(
      { command: node("process.exit(3)") },
      { ...ctx(), sandbox: fakeSandbox({ release: () => void released++ }) },
    );
    expect(released).toBe(1);
  });
});
