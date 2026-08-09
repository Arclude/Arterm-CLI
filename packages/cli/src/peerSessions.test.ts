import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { STATUS_DIR, peerSessions } from "./statusServer.js";

/**
 * Who else is working in this directory.
 *
 * The chronicle's watcher proves a file MOVED around a shell call and never
 * that the call moved it, so it names the alternatives instead — and on this
 * machine the loudest alternative is another arterm session, because the user
 * runs several at once. The discovery directory already knows; this is the read.
 *
 * Tested here because it is exactly the shape that failed twice in one evening:
 * a function wired into a pipeline, correct-looking, and never once executed.
 */
describe("peerSessions", () => {
  const written: string[] = [];
  const publish = (name: string, body: Record<string, unknown>): void => {
    mkdirSync(STATUS_DIR, { recursive: true });
    const file = join(STATUS_DIR, `${name}.json`);
    writeFileSync(file, JSON.stringify(body));
    written.push(file);
  };
  afterEach(() => {
    for (const f of written.splice(0)) rmSync(f, { force: true });
  });

  // A pid that is alive, ours to signal, and NOT this process — the self-check
  // is deliberate, so the test cannot lean on our own pid to prove liveness.
  const livePid = process.ppid;

  it("names a live session sharing the directory", () => {
    publish("peer-live", { pid: livePid, cwd: "/work/app", model: "glm-5.2" });
    expect(peerSessions("/work/app")).toEqual([`arterm ${livePid} (glm-5.2)`]);
  });

  it("ignores a session in a different checkout", () => {
    // Same machine is not the same tree — it could not have touched these files.
    publish("peer-elsewhere", { pid: livePid, cwd: "/work/other" });
    expect(peerSessions("/work/app")).toEqual([]);
  });

  it("counts a session whose cwd contains ours, and vice versa", () => {
    publish("peer-parent", { pid: livePid, cwd: "/work" });
    expect(peerSessions("/work/app")).toHaveLength(1);
  });

  it("ignores a dead pid rather than trusting the file", () => {
    // A crashed session leaves its discovery file behind until something sweeps
    // it, and crediting a dead process with a write is the same error as
    // missing a live one.
    publish("peer-dead", { pid: 2 ** 30, cwd: "/work/app" });
    expect(peerSessions("/work/app")).toEqual([]);
  });

  it("never counts itself", () => {
    publish("self", { pid: livePid, cwd: "/work/app", sessionId: "s1" });
    expect(peerSessions("/work/app", "s1")).toEqual([]);
  });

  it("shrugs off an unreadable entry", () => {
    mkdirSync(STATUS_DIR, { recursive: true });
    const file = join(STATUS_DIR, "broken.json");
    writeFileSync(file, "{not json");
    written.push(file);
    expect(() => peerSessions("/work/app")).not.toThrow();
  });
});
