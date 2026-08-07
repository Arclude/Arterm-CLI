import { execFileSync, execSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { patchTargets, unifiedDiff } from "./unifiedDiff.js";

const hasGit = (() => {
  try {
    execSync("git --version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe("unifiedDiff", () => {
  it("is empty for identical text", () => {
    expect(unifiedDiff("a\nb\n", "a\nb\n").text).toBe("");
  });

  it("counts the hunk header, both sides", () => {
    const r = unifiedDiff("one\ntwo\nthree\n", "one\nTWO\nthree\n");
    expect(r.text).toContain("@@ -1,3 +1,3 @@");
    expect(r.added).toBe(1);
    expect(r.removed).toBe(1);
    expect(r.hunks).toBe(1);
  });

  it("anchors an insertion at the top to line 0, not line 1", () => {
    // `@@ -1,0` is the off-by-one that makes patch(1) reject a valid diff.
    const r = unifiedDiff("", "new\n", { context: 0 });
    expect(r.text).toContain("@@ -0,0 +1,1 @@");
  });

  it("marks a missing trailing newline on the side that misses it", () => {
    const r = unifiedDiff("a\nb\n", "a\nc");
    expect(r.text).toContain("\\ No newline at end of file");
  });

  it("sees a change that is ONLY the trailing newline", () => {
    // Splitting on "\n" makes these the same line array; the files differ.
    const r = unifiedDiff("a\nb", "a\nb\n");
    expect(r.text).not.toBe("");
    expect(r.added).toBe(1);
    expect(r.removed).toBe(1);
    expect(r.text).toContain("\\ No newline at end of file");
  });

  it("merges nearby changes into one hunk and splits distant ones", () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i}`);
    const changed = [...lines];
    changed[1] = "CHANGED";
    changed[35] = "ALSO";
    const r = unifiedDiff(`${lines.join("\n")}\n`, `${changed.join("\n")}\n`);
    expect(r.hunks).toBe(2);

    const near = [...lines];
    near[10] = "A";
    near[12] = "B";
    expect(unifiedDiff(`${lines.join("\n")}\n`, `${near.join("\n")}\n`).hunks).toBe(1);
  });

  it("reports truncation rather than emitting half a patch quietly", () => {
    const before = `${Array.from({ length: 200 }, (_, i) => `l${i}`).join("\n")}\n`;
    const after = `${Array.from({ length: 200 }, (_, i) => `L${i}`).join("\n")}\n`;
    const r = unifiedDiff(before, after, { maxLines: 20 });
    expect(r.truncated).toBe(true);
    expect(r.text).toContain("diff truncated");
  });
});

describe("unifiedDiff output is a patch git will apply", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), "arterm-udiff-"));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  // The whole point of this module is producing text another program accepts.
  // Asserting on our own string is asserting we are self-consistent; only the
  // patch program can say whether the counts are right.
  const roundTrip = async (before: string, after: string) => {
    await fs.writeFile(join(dir, "f.txt"), before);
    const patch = unifiedDiff(before, after, { fromFile: "f.txt", toFile: "f.txt" }).text;
    await fs.writeFile(join(dir, "p.diff"), patch);
    execFileSync("git", ["apply", "--unsafe-paths", "-p1", "p.diff"], { cwd: dir });
    return fs.readFile(join(dir, "f.txt"), "utf8");
  };

  it.runIf(hasGit)("applies a single-line change", async () => {
    expect(await roundTrip("one\ntwo\nthree\n", "one\nTWO\nthree\n")).toBe("one\nTWO\nthree\n");
  });

  it.runIf(hasGit)("applies two distant hunks", async () => {
    const before = `${Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n")}\n`;
    const lines = before.trimEnd().split("\n");
    lines[1] = "CHANGED";
    lines[35] = "ALSO";
    const after = `${lines.join("\n")}\n`;
    expect(await roundTrip(before, after)).toBe(after);
  });

  it.runIf(hasGit)("applies a change that drops the trailing newline", async () => {
    expect(await roundTrip("a\nb\n", "a\nb")).toBe("a\nb");
  });

  it.runIf(hasGit)("applies a change that adds a trailing newline", async () => {
    expect(await roundTrip("a\nb", "a\nb\n")).toBe("a\nb\n");
  });

  it.runIf(hasGit)("applies an append to the end of a file", async () => {
    expect(await roundTrip("a\nb\n", "a\nb\nc\n")).toBe("a\nb\nc\n");
  });

  it.runIf(hasGit)("applies an insertion at the very top", async () => {
    expect(await roundTrip("a\nb\n", "z\na\nb\n")).toBe("z\na\nb\n");
  });
});

describe("patchTargets", () => {
  const patch = [
    "--- a/src/one.ts",
    "+++ b/src/one.ts",
    "@@ -1,1 +1,1 @@",
    "-x",
    "+y",
    "--- a/src/two.ts",
    "+++ b/src/two.ts",
    "@@ -1,1 +1,1 @@",
    "-x",
    "+y",
  ].join("\n");

  it("names every file the patch touches, once", () => {
    expect(patchTargets(patch)).toEqual(["src/one.ts", "src/two.ts"]);
  });

  it("honours the strip count the way -pN does", () => {
    expect(patchTargets(patch, 0)).toEqual([
      "a/src/one.ts",
      "b/src/one.ts",
      "a/src/two.ts",
      "b/src/two.ts",
    ]);
    expect(patchTargets(patch, 2)).toEqual(["one.ts", "two.ts"]);
  });

  it("ignores /dev/null, which is how a create or delete is spelled", () => {
    const create = "--- /dev/null\n+++ b/src/new.ts\n@@ -0,0 +1,1 @@\n+x\n";
    expect(patchTargets(create)).toEqual(["src/new.ts"]);
  });

  it("sees an escaping path so a caller can refuse it", () => {
    // git apply bounds paths by the REPOSITORY, not by the directory it runs
    // in, so this is the only place the tool's own boundary can be applied.
    const evil = "--- a/../../etc/passwd\n+++ b/../../etc/passwd\n@@ -1,1 +1,1 @@\n-x\n+y\n";
    expect(patchTargets(evil)).toEqual(["../../etc/passwd"]);
  });

  it("stops at the tab a timestamped header uses", () => {
    const dated = "--- a/x.ts\t2026-08-07 10:00:00\n+++ b/x.ts\t2026-08-07 10:01:00\n";
    expect(patchTargets(dated)).toEqual(["x.ts"]);
  });
});
