import { readFileSync, readdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { ARTERM_HOME } from "@arterm/core";
import { describe, expect, it } from "vitest";

/**
 * The tests in this package build REAL sessions and call `persist()`, which
 * writes `config.json`. That is correct behaviour being tested — the danger is
 * only ever WHERE it writes.
 *
 * It wrote the developer's own `~/.arterm/config.json`, and the way that failed
 * is the reason this guard is a test rather than a comment: nothing broke, and
 * nothing said anything. A real config's provider/model/permissions were reset
 * to `defaultConfig()`'s while every other field survived, so the file still
 * read as a working config — with `openaiCompatHost` still naming the live
 * endpoint next to `provider: "ollama"`. The next run went to an Ollama that
 * was not running, and the error surfaced three layers away as a team leader
 * that "proposed no work".
 *
 * `vitest.config.ts` redirects it. This asserts the redirect is still there,
 * because deleting that file is a one-line change whose only symptom is
 * somebody's config quietly changing under them days later.
 */
describe("tests never write the developer's real config", () => {
  it("resolves ARTERM_HOME to a throwaway directory, not $HOME/.arterm", () => {
    expect(ARTERM_HOME.startsWith(tmpdir())).toBe(true);
    expect(ARTERM_HOME).not.toBe(`${homedir()}/.arterm`);
  });
});

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/**
 * The one file allowed to ask the OS where home is — it is where `ARTERM_HOME`
 * is defined, and something has to compute the default.
 */
const CANONICAL = join("packages", "core", "src", "config.ts");

/** …and this guard, which asserts what that default looks like. */
const GUARD = join("packages", "cli", "src", "configIsolation.test.ts");

function sourceFiles(): string[] {
  const out: string[] = [];
  for (const pkg of readdirSync(join(REPO_ROOT, "packages"), { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue;
    const src = join(REPO_ROOT, "packages", pkg.name, "src");
    let entries: string[];
    try {
      entries = readdirSync(src, { recursive: true, encoding: "utf8" });
    } catch {
      continue; // a package without a src/ is not this test's business
    }
    for (const entry of entries) {
      if (entry.endsWith(".ts") || entry.endsWith(".tsx")) out.push(join(src, entry));
    }
  }
  return out;
}

/**
 * The guard above knows about ONE file. This one knows about the mistake.
 *
 * `statusServer.ts` computed `join(homedir(), ".arterm", "status")` itself, so
 * it never saw the `ARTERM_HOME` redirect `vitest.config.ts` sets — and
 * `statusServer.test.ts` creates discovery files and asserts they exist, which
 * means the suite wrote into the developer's real `~/.arterm/status` on every
 * run. It deleted them afterwards, so the only trace was a changed mtime.
 *
 * That is the same failure as the `config.json` overwrite, in a second place,
 * and the file-specific guard could not see it coming. A path built from
 * `homedir()` is unredirectable by construction, so the rule is about the CALL,
 * not about any one directory: import `ARTERM_HOME`, or you are outside the
 * thing that makes tests safe — and outside the sandbox's write roots, which is
 * why an `--autonomous` run could not test itself here either.
 */
/**
 * Reaching `homedir` means importing it. Matching the IMPORT rather than the
 * word is what keeps this guard from firing on the sentence "…comes from
 * ARTERM_HOME, not from homedir()" — a guard with false positives is one people
 * delete, and the comment explaining the rule must not break the rule.
 */
const IMPORTS_HOMEDIR = /import\s*\{[^}]*\bhomedir\b[^}]*\}\s*from\s*["']node:os["']/;
/** …and the namespace form, `import * as os` then `os.homedir()`. */
const CALLS_HOMEDIR = /\.homedir\s*\(/;

describe("nothing derives an Arterm path from the OS home", () => {
  it("leaves homedir() to the one file that defines ARTERM_HOME", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const rel = relative(REPO_ROOT, file);
      if (rel === CANONICAL || rel === GUARD) continue;
      const text = readFileSync(file, "utf8");
      if (IMPORTS_HOMEDIR.test(text) || CALLS_HOMEDIR.test(text)) {
        offenders.push(rel.split(sep).join("/"));
      }
    }
    // Named, not counted: "1 offender" sends the reader looking for it.
    expect(offenders).toEqual([]);
  });

  it("is actually looking at the tree — a scan that found nothing proves nothing", () => {
    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(100);
    expect(files.some((f) => f.endsWith(join("core", "src", "config.ts")))).toBe(true);
  });
});
