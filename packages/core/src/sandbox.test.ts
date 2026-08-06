import { mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
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

  it("derives the write root from the session cwd, resolved through symlinks", () => {
    const real = tmp();
    const link = join(tmp(), "link");
    symlinkSync(real, link);
    const spec = resolveSandbox({ enabled: true }, { cwd: link });
    // The LINK was handed in; the REAL path is the boundary. A prefix test on
    // the unresolved path is what a symlink escape defeats.
    expect(spec?.writeRoots).toContain(real);
    expect(spec?.writeRoots).not.toContain(link);
  });

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
    // the very thing being tested.
    const spec = {
      writeRoots: ["/work/project"],
      denyRead: [],
      allowedDomains: [],
      deniedDomains: [],
      failIfUnavailable: true,
    };
    expect(withinWriteRoots(spec, "/work/project")).toBe(true);
    expect(withinWriteRoots(spec, "/work/project/src")).toBe(true);
    // Starts with `/work/project` as a STRING but is not inside it.
    expect(withinWriteRoots(spec, "/work/project-evil")).toBe(false);
  });

  it("rejects an unrelated directory — the boundary is not widened to fit a caller", () => {
    const spec = resolveSandbox({ enabled: true }, { cwd: tmp() })!;
    expect(withinWriteRoots(spec, "/etc")).toBe(false);
  });
});
