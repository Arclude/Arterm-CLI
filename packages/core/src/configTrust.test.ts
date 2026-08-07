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

  it("nothing merges a second config source into the loaded one", () => {
    // `mergeConfig` exists to layer defaults under the file — one file.
    const merges = [...source.matchAll(/mergeConfig\(/g)];
    expect(merges.length).toBeLessThanOrEqual(2); // the definition and its one call
  });
});
