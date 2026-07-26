import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "@arterm/core";
import { describe, expect, it } from "vitest";
import { buildSession } from "./session.js";

/**
 * `session.permissionMode` is read by the desktop status snapshot and by
 * `/permissions`. It used to be assigned once at build time, so `--yolo` and
 * every Shift+Tab afterwards left both of them reporting the config's default —
 * an inspector describing a stricter session than the one actually running.
 */
describe("session.permissionMode", () => {
  const cwd = mkdtempSync(join(tmpdir(), "arterm-mode-"));

  it("reflects --yolo rather than the configured default", async () => {
    const config = { ...defaultConfig(), mode: "ask" as const };
    const { session } = await buildSession({ config, cwd, yolo: true });
    expect(session.permissionMode).toBe("yolo");
  });

  it("tracks a mid-session mode change", async () => {
    const config = { ...defaultConfig(), mode: "ask" as const };
    const { session } = await buildSession({ config, cwd });
    expect(session.permissionMode).toBe("ask");

    session.setMode("plan");
    expect(session.permissionMode).toBe("plan");
    session.setMode("auto");
    expect(session.permissionMode).toBe("auto");
  });
});
