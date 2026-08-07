import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clampMiddle, spoolOutput, sweepSpool } from "./toolOutput.js";

describe("clampMiddle", () => {
  it("leaves output that fits alone", () => {
    const r = clampMiddle("small", 1000);
    expect(r.text).toBe("small");
    expect(r.truncated).toBe(false);
  });

  it("keeps BOTH ends — the answer is usually at the bottom", () => {
    // Every truncation here used to keep the head. For a command's output that
    // is backwards: a build prints a thousand progress lines and the error on
    // the last one; a test run prints failures at the bottom.
    const text = `FIRST\n${"filler line\n".repeat(2000)}LAST`;
    const r = clampMiddle(text, 2000);
    expect(r.truncated).toBe(true);
    expect(r.text.startsWith("FIRST")).toBe(true);
    expect(r.text.endsWith("LAST")).toBe(true);
  });

  it("never returns more than it was asked for", () => {
    // Including the marker: a clamp that exceeds its budget is not a clamp.
    for (const cap of [64, 256, 1024, 4096]) {
      const r = clampMiddle("x".repeat(50_000), cap);
      expect(Buffer.byteLength(r.text, "utf8"), `cap=${cap}`).toBeLessThanOrEqual(cap);
    }
  });

  it("says how much it removed", () => {
    const r = clampMiddle("y".repeat(10_000), 500);
    expect(r.text).toMatch(/\[\d+ bytes cut from the middle\]/);
    expect(r.originalBytes).toBe(10_000);
  });

  it("measures bytes, not characters", () => {
    // 1000 emoji is 4000 bytes; a character-based cap would let it through.
    const r = clampMiddle("🚀".repeat(1000), 1000);
    expect(r.truncated).toBe(true);
    expect(Buffer.byteLength(r.text, "utf8")).toBeLessThanOrEqual(1000);
  });

  it("never splits a surrogate pair", () => {
    // A string cut mid-surrogate is a replacement character in the transcript
    // and in whatever the model quotes back.
    const r = clampMiddle("🚀".repeat(5000), 777);
    expect(r.text).not.toContain("�");
    expect([...r.text].every((ch) => ch.codePointAt(0) !== 0xfffd)).toBe(true);
  });

  it("degrades to just the marker when the budget is tiny", () => {
    const r = clampMiddle("z".repeat(1000), 10);
    expect(r.truncated).toBe(true);
    expect(r.text).toContain("cut from the middle");
  });
});

describe("spooling", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), "arterm-spool-"));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("writes the whole output where the model can go back for it", async () => {
    const file = await spoolOutput("the entire thing", "bash", dir);
    expect(file).toBeTruthy();
    expect(await fs.readFile(file as string, "utf8")).toBe("the entire thing");
  });

  it("returns nothing rather than throwing when it cannot write", async () => {
    // Spooling is a convenience; a tool call must not fail because a cache
    // directory is read-only.
    // A path whose parent is a FILE: mkdir fails with ENOTDIR immediately.
    await fs.writeFile(join(dir, "blocker"), "");
    const file = await spoolOutput("x", "bash", join(dir, "blocker", "sub"));
    expect(file).toBeUndefined();
  });

  it("sweeps files past their age and keeps the rest", async () => {
    const old = await spoolOutput("old", "bash", dir, 1);
    const fresh = await spoolOutput("fresh", "bash", dir);
    await fs.utimes(old as string, new Date(0), new Date(0));

    const removed = await sweepSpool(dir, 1000);
    expect(removed).toBe(1);
    expect(await fs.readFile(fresh as string, "utf8")).toBe("fresh");
  });

  it("sweeping a directory that was never created is not an error", async () => {
    await expect(sweepSpool(join(dir, "nope"))).resolves.toBe(0);
  });
});
