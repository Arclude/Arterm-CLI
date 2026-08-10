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

/**
 * The redirect is per PACKAGE, so a rule about one package protects one package.
 *
 * `packages/cli` had it and `packages/core` did not, which meant a single
 * `agent.test.ts` case spooled a real file into the developer's
 * `~/.arterm/tool-output` — `spoolDir()` is `join(ARTERM_HOME, "tool-output")`,
 * and with nothing redirecting it that is the live directory. Counted before and
 * after one test: 240 files, then 241.
 *
 * `packages/tui` shows why "has a config" is not the check: it had one, for
 * FORCE_COLOR, and the file's existence is precisely what stopped anyone opening
 * it. So the assertion is about the SETTING, in every package that runs tests at
 * all — a blanket rule, deliberately, because an exception list is a place for
 * the next package to be forgotten.
 */
/**
 * …and the ROOT is the place a per-package rule cannot reach.
 *
 * Every config above is loaded only when vitest runs INSIDE that package.
 * `pnpm exec vitest run` from the workspace root loads none of them, resolves
 * test files across all packages, and prints the same green summary — while
 * writing wherever the unredirected `ARTERM_HOME` points. It wiped a real
 * `~/.arterm/config.json` to `{}`: correct delta-persist behaviour for a
 * session built from `defaultConfig()`, performed in the developer's own home.
 *
 * So the root carries a config too, and this asserts it — the fourth instance
 * of the same mistake, fixed as a default rather than as a thing to remember.
 */
describe("the workspace root redirects ARTERM_HOME too", () => {
  it("has a root vitest config, so a root-run cannot write the real home", () => {
    const config = readFileSync(join(REPO_ROOT, "vitest.config.ts"), "utf8");
    expect(config).toContain("ARTERM_HOME");
    expect(config).toContain("tmpdir");
  });
});

describe("every package that runs tests redirects ARTERM_HOME", () => {
  it("sets it in each package's own vitest config", () => {
    const missing: string[] = [];
    for (const pkg of readdirSync(join(REPO_ROOT, "packages"), { withFileTypes: true })) {
      if (!pkg.isDirectory()) continue;
      const hasTests = readdirSync(join(REPO_ROOT, "packages", pkg.name, "src"), {
        recursive: true,
        encoding: "utf8",
      }).some((f) => f.includes(".test."));
      if (!hasTests) continue;
      let config = "";
      try {
        config = readFileSync(join(REPO_ROOT, "packages", pkg.name, "vitest.config.ts"), "utf8");
      } catch {
        missing.push(`${pkg.name} (no vitest.config.ts)`);
        continue;
      }
      if (!config.includes("ARTERM_HOME")) missing.push(`${pkg.name} (config sets no ARTERM_HOME)`);
    }
    expect(missing).toEqual([]);
  });
});
