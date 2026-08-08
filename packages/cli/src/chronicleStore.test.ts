import { appendFileSync, mkdirSync, rmSync } from "node:fs";
import { Chronicle, verifyChain } from "@arterm/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  CHRONICLE_DIR,
  chronicleFile,
  createChronicleSink,
  readChronicle,
} from "./chronicleStore.js";

/**
 * The store writes under ARTERM_HOME, which `vitest.config.ts` points at a temp
 * directory — see `configIsolation.test.ts` for why that redirect is a guarded
 * invariant rather than a convenience.
 */
const ids: string[] = [];
const session = (name: string): string => {
  const id = `test-${name}-${ids.length}`;
  ids.push(id);
  return id;
};

afterEach(() => {
  for (const id of ids.splice(0)) rmSync(chronicleFile(id), { force: true });
});

describe("the chronicle store", () => {
  it("round-trips sealed records, chain intact", () => {
    const id = session("roundtrip");
    const chronicle = new Chronicle(createChronicleSink(id), () => ({ sessionId: id }));
    chronicle.append({
      eventType: "tool.executed",
      outcome: "success",
      scope: {},
      toolName: "write",
    });
    chronicle.append({ eventType: "tool.executed", outcome: "failure", scope: {} });

    const { records, unreadable } = readChronicle(id);
    expect(records).toHaveLength(2);
    expect(unreadable).toBe(0);
    // Verified rather than compared field by field: the point of persisting is
    // that what comes back still hashes to what went in.
    expect(verifyChain(records).ok).toBe(true);
    expect(records[0]?.scope.sessionId).toBe(id);
  });

  it("drops a half-written tail instead of failing the whole read", () => {
    // The crash this format exists to survive: the process died mid-append. One
    // torn line must not take the ledger with it.
    const id = session("torn");
    const chronicle = new Chronicle(createChronicleSink(id));
    chronicle.append({ eventType: "tool.executed", outcome: "success", scope: {} });
    mkdirSync(CHRONICLE_DIR, { recursive: true });
    appendFileSync(chronicleFile(id), '{"eventType":"tool.exec', "utf8");

    const { records, unreadable } = readChronicle(id);
    expect(records).toHaveLength(1);
    expect(unreadable).toBe(1);
    expect(verifyChain(records).ok).toBe(true);
  });

  it("reads an absent ledger as empty, not as an error", () => {
    const { records, unreadable } = readChronicle("never-existed");
    expect(records).toEqual([]);
    expect(unreadable).toBe(0);
  });

  it("keeps a session id from becoming a path", () => {
    // The id comes from the CLI rather than model output, but it still becomes
    // a filename — reduced to safe characters rather than trusted to be one.
    //
    // Asserted as the PROPERTY (the result is a plain name inside the chronicle
    // directory), not as the exact mangled string: the latter tests the
    // substitution regex, and would have to be rewritten every time the safe
    // set changes while proving nothing more.
    for (const hostile of ["../../etc/passwd", "/etc/shadow", "a/../../b", ""]) {
      const file = chronicleFile(hostile);
      expect(file.startsWith(`${CHRONICLE_DIR}/`)).toBe(true);
      expect(file.slice(CHRONICLE_DIR.length + 1)).not.toContain("/");
    }
  });
});
