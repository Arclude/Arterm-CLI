import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gitCommitTool, gitTool } from "./git.js";
import { detectScripts, formatTool, lintTool, testTool } from "./project.js";

const run = promisify(execFile);
async function hasGit(): Promise<boolean> {
  try {
    await run("git", ["--version"]);
    return true;
  } catch {
    return false;
  }
}
const gitAvailable = await hasGit();

let dir: string;
const ctx = () => ({ cwd: dir });

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), "arterm-gitproj-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("gitTool", () => {
  it("is a read-only, no-prompt tool", () => {
    expect(gitTool.permission).toBe("allow");
    expect(gitTool.category).toBe("read");
    expect(gitTool.mutating).toBeFalsy();
  });

  it("rejects a smuggled mutating flag", async () => {
    const res = await gitTool.execute({ subcommand: "log", args: "--exec=rm" }, ctx());
    expect(res.isError).toBe(true);
    expect(res.output).toMatch(/Refused/);
  });

  it("rejects an unknown subcommand", async () => {
    const res = await gitTool.execute({ subcommand: "push" }, ctx());
    expect(res.isError).toBe(true);
  });

  it.skipIf(!gitAvailable)("reports a new file in status", async () => {
    await run("git", ["init"], { cwd: dir });
    await fs.writeFile(join(dir, "hello.txt"), "hi\n");
    const res = await gitTool.execute({ subcommand: "status" }, ctx());
    expect(res.output).toContain("hello.txt");
  });
});

describe("gitCommitTool", () => {
  it("is a gated, mutating edit tool", () => {
    expect(gitCommitTool.permission).toBe("ask");
    expect(gitCommitTool.mutating).toBe(true);
    expect(gitCommitTool.category).toBe("edit");
  });

  it.skipIf(!gitAvailable)("stages and creates a commit", async () => {
    await run("git", ["init"], { cwd: dir });
    await run("git", ["config", "user.email", "t@example.com"], { cwd: dir });
    await run("git", ["config", "user.name", "Test"], { cwd: dir });
    await fs.writeFile(join(dir, "f.txt"), "content\n");

    const res = await gitCommitTool.execute({ message: "add f", all: true }, ctx());
    expect(res.isError).toBeFalsy();
    const log = await run("git", ["log", "--oneline"], { cwd: dir });
    expect(log.stdout).toContain("add f");
  });
});

describe("project tools", () => {
  it("detectScripts picks pnpm from the lockfile", async () => {
    await fs.writeFile(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    await fs.writeFile(join(dir, "package.json"), JSON.stringify({ scripts: { test: "x" } }));
    const detected = detectScripts(dir);
    expect(detected.pm).toBe("pnpm");
    expect(detected.scripts.test).toBe("x");
  });

  it("testTool runs the package.json test script", async () => {
    await fs.writeFile(
      join(dir, "package.json"),
      JSON.stringify({ scripts: { test: "node -e \"process.stdout.write('OK-RAN')\"" } }),
    );
    const res = await testTool.execute({}, ctx());
    expect(res.output).toContain("OK-RAN");
  });

  it("testTool errors when there is no test script", async () => {
    await fs.writeFile(join(dir, "package.json"), JSON.stringify({ scripts: {} }));
    const res = await testTool.execute({}, ctx());
    expect(res.isError).toBe(true);
    expect(res.output).toMatch(/No `test` script/);
  });

  it("lint is read-only and format is gated", () => {
    expect(lintTool.category).toBe("read");
    expect(lintTool.permission).toBe("allow");
    expect(formatTool.permission).toBe("ask");
    expect(formatTool.mutating).toBe(true);
  });
});

describe("git and the session's credentials", () => {
  // `git` is not sandboxed — it is a fixed read-only subcommand list with the
  // code-running flags refused — so the environment is the only thing standing
  // between a repository's own config and the user's provider keys. A repo can
  // point git at an external program (`diff.external`, `core.fsmonitor`), and
  // that program inherits whatever git was spawned with. This was the one
  // process-spawning tool that still handed over the whole environment while
  // `bash`, `exec` and the project scripts had been scrubbed.
  beforeEach(() => {
    process.env.ARTERM_TEST_API_KEY = "sk-leaked";
    process.env.ARTERM_TEST_PLAIN = "visible";
  });
  afterEach(() => {
    Reflect.deleteProperty(process.env, "ARTERM_TEST_API_KEY");
    Reflect.deleteProperty(process.env, "ARTERM_TEST_PLAIN");
  });

  it.skipIf(!gitAvailable)("does not hand a credential-named variable to git", async () => {
    await run("git", ["init", "-q"], { cwd: dir });
    // `diff.external` is the vector in one line: git runs it, and it prints the
    // environment it was given rather than a diff.
    const probe = join(dir, "probe.sh");
    await fs.writeFile(
      probe,
      '#!/bin/sh\necho "KEY=${ARTERM_TEST_API_KEY:-absent} PLAIN=${ARTERM_TEST_PLAIN:-absent}"\n',
    );
    await fs.chmod(probe, 0o755);
    await run("git", ["config", "diff.external", probe], { cwd: dir });
    await fs.writeFile(join(dir, "f.txt"), "one\n");
    await run("git", ["add", "-A"], { cwd: dir });
    await run("git", ["-c", "user.email=t@e.c", "-c", "user.name=t", "commit", "-qm", "base"], {
      cwd: dir,
    });
    await fs.writeFile(join(dir, "f.txt"), "two\n");

    const res = await gitTool.execute({ subcommand: "diff" }, ctx());
    // The positive anchor: the external program DID run, so "no key" is a
    // measurement rather than a program that never executed.
    expect(res.output).toContain("PLAIN=visible");
    expect(res.output).toContain("KEY=absent");
    expect(res.output).not.toContain("sk-leaked");
  });
});
