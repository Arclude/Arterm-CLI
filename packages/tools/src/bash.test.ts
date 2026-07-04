import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
