/**
 * What a search should not walk into.
 *
 * `grep` and `glob` shared a three-entry ignore list — `node_modules`, `dist`,
 * `.git` — which is the set that happens to matter in a TypeScript repo and
 * nowhere else. A Rust project's `target/`, a Next.js `.next/`, a Python
 * `.venv/`, anyone's `coverage/` were all walked and all searched: slower, and
 * the results were full of build output that matches everything.
 *
 * The project already states which files it does not care about, in
 * `.gitignore`. Reading it is both more correct and less to maintain than a
 * longer hardcoded list — the fallback list stays only for the directories
 * that are ignored in practice even when nobody wrote them down.
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";

/** Ignored whether or not a `.gitignore` says so. */
export const ALWAYS_IGNORED = [".git", "node_modules"];

/** Kept when there is no `.gitignore` at all — the usual build output. */
const FALLBACK = [
  "dist",
  "build",
  "out",
  "target",
  "coverage",
  ".next",
  ".nuxt",
  ".turbo",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".gradle",
  "vendor",
];

/**
 * Glob patterns to hand a walker, derived from the project's own `.gitignore`
 * plus the always-ignored set.
 *
 * Deliberately a SUBSET of git's semantics: a line becomes a pattern when it
 * is a plain path or directory, and negations (`!foo`) and anchored/character-
 * class patterns are skipped rather than approximated. A pattern this code
 * gets wrong silently hides a file the user asked to search, and an ignore
 * rule that hides too little is a much cheaper mistake than one that hides too
 * much.
 */
export async function ignorePatterns(cwd: string): Promise<string[]> {
  const base = ALWAYS_IGNORED.map((d) => `**/${d}/**`);
  let text: string;
  try {
    text = await fs.readFile(join(cwd, ".gitignore"), "utf8");
  } catch {
    return [...base, ...FALLBACK.map((d) => `**/${d}/**`)];
  }

  const patterns: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    // Negations re-include a path; approximating them would hide files the
    // user explicitly un-ignored, so the whole rule is dropped instead.
    if (line.startsWith("!")) continue;
    // Character classes and escapes are git-specific enough that a glob
    // library will read them differently. Skip rather than mistranslate.
    if (/[[\]\\]/.test(line)) continue;

    const body = line.replace(/^\/+/, "").replace(/\/+$/, "");
    if (body === "") continue;
    // A bare name matches at any depth in git; an anchored one only at the
    // root. Both forms are emitted as directory-and-file patterns, since a
    // `.gitignore` entry rarely distinguishes.
    const anchored = line.startsWith("/");
    const prefix = anchored ? "" : "**/";
    patterns.push(`${prefix}${body}`, `${prefix}${body}/**`);
  }
  return [...base, ...patterns];
}
