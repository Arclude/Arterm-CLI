import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionLog, loadSessionMessages } from "./sessions.js";
import type { Message } from "./types.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), "arterm-sessions-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("loadSessionMessages", () => {
  it("round-trips logged messages and skips the meta line", async () => {
    const log = await SessionLog.create({ model: "m", provider: "p" }, dir);
    const sent: Message[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
    ];
    for (const m of sent) await log.logMessage(m);

    expect(await loadSessionMessages(log.id, dir)).toEqual(sent);
  });

  it("tolerates malformed lines without aborting the transcript", async () => {
    const log = await SessionLog.create({ model: "m", provider: "p" }, dir);
    await log.logMessage({ role: "user", content: "ok" });
    await fs.appendFile(log.path, "not json\n", "utf8");
    await fs.appendFile(
      log.path,
      `${JSON.stringify({ kind: "message", role: "assistant", content: "after" })}\n`,
      "utf8",
    );

    expect(await loadSessionMessages(log.id, dir)).toEqual([
      { role: "user", content: "ok" },
      { role: "assistant", content: "after" },
    ]);
  });

  it("returns [] for an unknown id", async () => {
    expect(await loadSessionMessages("does-not-exist", dir)).toEqual([]);
  });

  it("accepts a full .jsonl path", async () => {
    const log = await SessionLog.create({ model: "m", provider: "p" }, dir);
    await log.logMessage({ role: "user", content: "x" });
    expect(await loadSessionMessages(log.path, dir)).toEqual([{ role: "user", content: "x" }]);
  });
});
