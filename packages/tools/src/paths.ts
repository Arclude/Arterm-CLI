import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

/** True when `rel` (a path relative to some base) points outside that base. */
function escapes(rel: string): boolean {
  return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

/**
 * Realpath the deepest existing ancestor of `target`, re-appending any not-yet-
 * existing trailing segments. Lets us confine a path that doesn't exist yet (e.g.
 * `write` creating a file) by the real location of its parent directory.
 */
function realpathOfNearest(target: string): string {
  let prefix = resolve(target);
  const suffix: string[] = [];
  while (true) {
    try {
      const real = realpathSync(prefix);
      return suffix.length ? resolve(real, ...suffix.reverse()) : real;
    } catch {
      const parent = dirname(prefix);
      if (parent === prefix) return resolve(target); // hit the root; nothing exists
      suffix.push(basename(prefix));
      prefix = parent;
    }
  }
}

/**
 * Resolves a user/model-supplied path against the agent's working directory and
 * refuses anything that escapes it. This is the primary guard that keeps tools
 * from touching files outside the project the agent was pointed at.
 *
 * Confinement is checked both lexically AND against the realpath, so a symlink
 * sitting inside cwd cannot point the tool at a file outside cwd (e.g. `link ->
 * /etc/passwd`). The lexical path is returned for the caller to operate on.
 */
export function resolveWithin(cwd: string, p: string): string {
  const abs = isAbsolute(p) ? p : resolve(cwd, p);
  if (escapes(relative(cwd, abs))) {
    throw new Error(`Path escapes the working directory: ${p}`);
  }
  // Re-check after resolving symlinks (the lexical check above can't see them).
  if (escapes(relative(realpathOfNearest(cwd), realpathOfNearest(abs)))) {
    throw new Error(`Path escapes the working directory (via symlink): ${p}`);
  }
  return abs;
}

/** True when `abs` is inside (or equal to) `cwd`. */
export function isWithin(cwd: string, abs: string): boolean {
  const rel = relative(cwd, abs);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/**
 * Refuses glob patterns that could escape the working directory — absolute
 * patterns or any `..` segment. read-only search tools (glob/grep) run without a
 * permission prompt, so this is what keeps them from reading e.g. ~/.ssh.
 */
export function assertSafeGlob(pattern: string): void {
  if (isAbsolute(pattern) || /(^|[\\/])\.\.([\\/]|$)/.test(pattern)) {
    throw new Error(`Pattern must stay within the working directory: ${pattern}`);
  }
}

export function requireString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`Missing required string argument: ${key}`);
  }
  return v;
}

export function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === "string" ? v : undefined;
}
