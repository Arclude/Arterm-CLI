import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "@arterm/core";
import { describe, expect, it } from "vitest";
import { buildSession } from "./session.js";

/**
 * `hooks.ts` is unit-tested on its own, and that is exactly what could not catch
 * the bug this file exists for: `sessionEnd` was declared in the config schema,
 * typed in `HookSettings`, and counted by `hasAnyHook` — so it validated, it
 * installed the hook machinery, and it never ran, because nothing in
 * `buildSession` was subscribed to it. Every test of the hook RUNNER passed.
 *
 * A hook is only real at the seam where the session fires it, so these tests
 * build a real session and observe the side effect of the command itself.
 */

/** Poll for a detached observer's side effect, which by design nothing awaits. */
async function waitForFile(path: string, ms = 5000): Promise<string> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      const body = readFileSync(path, "utf8");
      if (body.length > 0) return body;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`hook never wrote ${path}`);
}

describe("lifecycle hooks reach the session that fires them", () => {
  it("runs sessionEnd on teardown, the half that was dead config", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "arterm-hooks-"));
    const marker = join(cwd, "ended.txt");
    const config = defaultConfig();
    config.hooks = { sessionEnd: `printf '%s' "$ARTERM_HOOK_SOURCE" > ${marker}` };

    const { persist } = await buildSession({ config, cwd });
    expect(existsSync(marker), "sessionEnd fired before the session ended").toBe(false);

    await persist();
    expect(await waitForFile(marker)).toBe("close");
  });

  it("runs sessionStart with the session's own id in the environment", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "arterm-hooks-"));
    const marker = join(cwd, "started.txt");
    const config = defaultConfig();
    config.hooks = { sessionStart: `printf '%s' "$ARTERM_HOOK_EVENT" > ${marker}` };

    await buildSession({ config, cwd });
    expect(await waitForFile(marker)).toBe("session_start");
  });
});
