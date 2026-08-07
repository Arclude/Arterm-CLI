import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Where configuration is allowed to come from.
 *
 * `exec.allow` widens the list of programs the agent may start, and
 * `sandbox.allowedDomains` widens where a command may reach. Both are safe
 * today for one reason and one reason only: config is read from the USER's home
 * and from nowhere else, so a cloned repository cannot ship a file that grants
 * itself either.
 *
 * That is an invariant, not a coincidence, and a comment saying so is not a
 * control. This test is: adding a project-level config layer — reading
 * `.arterm/config.json` from the cwd, merging a `package.json` key, honouring a
 * `--config` flag — makes it fail, which is the moment to decide which fields
 * that layer may touch.
 */
describe("config comes from the user's home, and nowhere else", () => {
  const source = readFileSync(join(import.meta.dirname, "config.ts"), "utf8");

  it("reads exactly one file, under ARTERM_HOME", () => {
    // Every path the loader can open.
    const reads = [...source.matchAll(/fs\.readFile\(([^,)]+)/g)].map((m) => m[1]?.trim());
    expect(reads).toEqual(["CONFIG_PATH"]);
    expect(source).toMatch(/const CONFIG_PATH = join\(ARTERM_HOME, "config\.json"\)/);
  });

  it("ARTERM_HOME is the user's home, not the working directory", () => {
    expect(source).toMatch(/ARTERM_HOME[^\n]*homedir\(\)/);
    expect(source).not.toMatch(/join\(\s*process\.cwd\(\)/);
  });

  /**
   * `$ARTERM_HOME` may move it, and that is deliberate — it is the only channel
   * that can act BEFORE this module loads, which is what a test runner (and a
   * CI job, and a second profile) needs. It does not weaken the invariant above:
   * the threat that test guards is a CLONED REPO shipping a config that grants
   * itself `exec.allow` or an egress domain, and an env var is not something a
   * checkout carries. The model cannot reach it either — a tool call sets the
   * environment of the child it spawns, never of the running CLI.
   *
   * What it must never become is a path DERIVED from the tree being worked on.
   * `cwd`, a repo file, or an argv value would each hand that grant straight
   * back to the clone.
   */
  it("the ARTERM_HOME override reads the environment and nothing else", () => {
    const line = source.split("\n").find((l) => l.includes("export const ARTERM_HOME"));
    expect(line).toBeDefined();
    expect(line).toMatch(/process\.env\.ARTERM_HOME/);
    expect(line).not.toMatch(/cwd\(\)|argv|readFile/);
  });

  it("nothing merges a second config source into the loaded one", () => {
    // `mergeConfig` exists to layer defaults under the file — one file.
    const merges = [...source.matchAll(/mergeConfig\(/g)];
    expect(merges.length).toBeLessThanOrEqual(2); // the definition and its one call
  });
});
