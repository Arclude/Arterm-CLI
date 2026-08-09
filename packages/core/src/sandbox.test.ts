import { mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ARTERM_HOME } from "./config.js";
import { keystorePaths } from "./keystore.js";
import {
  DEFAULT_ALLOWED_DOMAINS,
  describeSandbox,
  resolveSandbox,
  withinWriteRoots,
} from "./sandbox.js";

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), "arterm-sandbox-")));

describe("resolveSandbox", () => {
  it("is off unless enabled — the boundary is opt-in, never implied", () => {
    expect(resolveSandbox(undefined, { cwd: tmp() })).toBeUndefined();
    expect(resolveSandbox({}, { cwd: tmp() })).toBeUndefined();
    expect(resolveSandbox({ enabled: false }, { cwd: tmp() })).toBeUndefined();
  });

  // Creating a directory symlink on Windows needs a privilege the CI runner may
  // not have, and the property under test (realpath before comparing) is the
  // POSIX escape route this defends against. Skipping beats a flaky red build.
  it.skipIf(process.platform === "win32")(
    "derives the write root from the session cwd, resolved through symlinks",
    () => {
      const real = tmp();
      const link = join(tmp(), "link");
      symlinkSync(real, link);
      const spec = resolveSandbox({ enabled: true }, { cwd: link });
      // The LINK was handed in; the REAL path is the boundary. A prefix test on
      // the unresolved path is what a symlink escape defeats.
      expect(spec?.writeRoots).toContain(real);
      expect(spec?.writeRoots).not.toContain(link);
    },
  );

  it("includes the temp dir, so build tools and worktree workers can write", () => {
    const spec = resolveSandbox({ enabled: true }, { cwd: tmp() });
    expect(spec?.writeRoots).toContain(realpathSync(tmpdir()));
  });

  it("honors an empty allowlist as deny-all rather than falling back to defaults", () => {
    const spec = resolveSandbox({ enabled: true, allowedDomains: [] }, { cwd: tmp() });
    expect(spec?.allowedDomains).toEqual([]);
    expect(describeSandbox(spec!)).toContain("no network");
  });

  it("supplies the developer allowlist only when the field is absent", () => {
    const spec = resolveSandbox({ enabled: true }, { cwd: tmp() });
    expect(spec?.allowedDomains).toEqual([...DEFAULT_ALLOWED_DOMAINS]);
    expect(spec?.deniedDomains).toContain("*:22");
  });

  it("fails closed when unattended and open when attended", () => {
    const cwd = tmp();
    expect(resolveSandbox({ enabled: true }, { cwd, unattended: true })?.failIfUnavailable).toBe(
      true,
    );
    expect(resolveSandbox({ enabled: true }, { cwd, unattended: false })?.failIfUnavailable).toBe(
      false,
    );
    // An explicit setting beats the inference in both directions.
    expect(
      resolveSandbox({ enabled: true, failIfUnavailable: false }, { cwd, unattended: true })
        ?.failIfUnavailable,
    ).toBe(false);
  });

  it("resolves extra write paths relative to the session root, not the process cwd", () => {
    const root = tmp();
    const spec = resolveSandbox({ enabled: true, allowWrite: ["sub"] }, { cwd: root });
    expect(spec?.writeRoots).toContain(join(root, "sub"));
  });
});

describe("withinWriteRoots", () => {
  it("accepts the root itself and paths under it", () => {
    const root = tmp();
    const spec = resolveSandbox({ enabled: true }, { cwd: root })!;
    expect(withinWriteRoots(spec, root)).toBe(true);
    expect(withinWriteRoots(spec, join(root, "a", "b"))).toBe(true);
  });

  it("rejects a sibling whose path merely shares the prefix string", () => {
    // Hand-built rather than resolved, because `resolveSandbox` always grants
    // the temp dir — which would contain both sides of this comparison and hide
    // the very thing being tested. Paths go through `resolve` so this reads the
    // same on Windows, where the separator is a backslash.
    const root = resolve("/work/project");
    const spec = {
      writeRoots: [root],
      denyRead: [],
      allowedDomains: [],
      deniedDomains: [],
      failIfUnavailable: true,
    };
    expect(withinWriteRoots(spec, root)).toBe(true);
    expect(withinWriteRoots(spec, join(root, "src"))).toBe(true);
    // Starts with the root as a STRING but is not inside it.
    expect(withinWriteRoots(spec, `${root}-evil`)).toBe(false);
  });

  it("rejects an unrelated directory — the boundary is not widened to fit a caller", () => {
    const spec = resolveSandbox({ enabled: true }, { cwd: tmp() })!;
    expect(withinWriteRoots(spec, "/etc")).toBe(false);
  });
});

/**
 * The one denial that does not come from config.
 *
 * `denyRead` was empty by default and the mechanism's own comment argued reads
 * need no boundary because "the exfiltration path is egress". For two files
 * that is false, and `credentials.ts` says why: a secret read into a tool
 * result leaves through Arterm's own request to the model, which no egress rule
 * is on the path of.
 */
describe("the keystore is denied to a sandboxed command", () => {
  it("denies the key and the ciphertext beside it, with nothing configured", () => {
    const spec = resolveSandbox({ enabled: true }, { cwd: tmp() })!;
    for (const path of keystorePaths()) expect(spec.denyRead).toContain(path);
  });

  it("keeps the floor when config sets its own list, and adds to it", () => {
    // A floor, not a default: `allowedDomains: []` has a meaning a user can
    // intend, and "let the agent read my own API keys" has none.
    const root = tmp();
    const spec = resolveSandbox({ enabled: true, denyRead: ["private"] }, { cwd: root })!;
    for (const path of keystorePaths()) expect(spec.denyRead).toContain(path);
    expect(spec.denyRead).toContain(join(root, "private"));
  });

  it("survives an explicitly emptied list", () => {
    const spec = resolveSandbox({ enabled: true, denyRead: [] }, { cwd: tmp() })!;
    expect(spec.denyRead.length).toBeGreaterThan(0);
  });

  it("denies the files, never the directory the model is sent to", () => {
    // Spooled tool output lives under the same home and the model is handed the
    // path; denying the directory would break the retrieval that exists so a
    // command need not be re-run.
    const spec = resolveSandbox({ enabled: true }, { cwd: tmp() })!;
    expect(spec.denyRead).not.toContain(ARTERM_HOME);
    for (const path of spec.denyRead) expect(path).not.toBe(join(ARTERM_HOME, "tool-output"));
  });
});
