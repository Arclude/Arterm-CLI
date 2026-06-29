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
