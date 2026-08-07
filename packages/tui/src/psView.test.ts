import type { ManagedProcess } from "@arterm/core";
import { describe, expect, it } from "vitest";
import { formatProcessOutput, formatProcesses, parsePsArgs } from "./psView.js";

const NOW = 1_700_000_000_000;
const proc = (over: Partial<ManagedProcess> & { id: string }): ManagedProcess => ({
  label: "npm run dev",
  startedAt: NOW - 90_000,
  state: "running",
  output: "",
  pid: 4242,
  ...over,
});

describe("parsePsArgs", () => {
  it("defaults to listing", () => {
    expect(parsePsArgs([])).toEqual({ kind: "list" });
  });

  it("takes kill and stop as the same verb", () => {
    expect(parsePsArgs(["kill", "p1"])).toEqual({ kind: "kill", id: "p1" });
    expect(parsePsArgs(["stop", "p1"])).toEqual({ kind: "kill", id: "p1" });
  });

  it("understands `all`", () => {
    expect(parsePsArgs(["kill", "all"])).toEqual({ kind: "kill-all" });
  });

  it("explains itself rather than guessing", () => {
    expect(parsePsArgs(["kill"])).toMatchObject({ kind: "usage" });
    expect(parsePsArgs(["nuke", "p1"])).toMatchObject({ kind: "usage" });
  });
});

describe("formatProcesses", () => {
  it("says how to start one when there are none", () => {
    // An empty table that does not say what it is for is a dead end.
    const out = formatProcesses([], NOW);
    expect(out).toContain("No background processes");
    expect(out).toContain("background: true");
  });

  it("shows id, pid, age, state and the command", () => {
    const out = formatProcesses([proc({ id: "p1" })], NOW);
    expect(out).toContain("p1");
    expect(out).toContain("pid 4242");
    expect(out).toContain("1m30s");
    expect(out).toContain("npm run dev");
  });

  it("shows an exit code for something that ended", () => {
    const out = formatProcesses(
      [proc({ id: "p1", state: "exited", endedAt: NOW - 30_000, exitCode: 1 })],
      NOW,
    );
    expect(out).toContain("exit 1");
    // Ended processes stay listed: the session's record of what it ran.
    expect(out).toContain("p1");
  });

  it("counts what is still running and says how to stop it", () => {
    const out = formatProcesses(
      [proc({ id: "p1" }), proc({ id: "p2", state: "exited", endedAt: NOW })],
      NOW,
    );
    expect(out).toContain("2 process(es), 1 running");
    expect(out).toContain("/ps kill");
  });
});

describe("formatProcessOutput", () => {
  it("says so when nothing has been printed yet", () => {
    expect(formatProcessOutput(proc({ id: "p1" }))).toContain("(no output yet)");
  });

  it("keeps the TAIL and counts what it dropped", () => {
    const output = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
    const out = formatProcessOutput(proc({ id: "p1", output }), 5);
    expect(out).toContain("line 199");
    expect(out).not.toContain("line 100");
    expect(out).toContain("earlier line(s)");
  });
});
