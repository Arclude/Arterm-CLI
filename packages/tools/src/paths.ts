import { isAbsolute, relative, resolve, sep } from "node:path";

/**
 * Resolves a user/model-supplied path against the agent's working directory and
 * refuses anything that escapes it. This is the primary guard that keeps tools
 * from touching files outside the project the agent was pointed at.
 */
export function resolveWithin(cwd: string, p: string): string {
  const abs = isAbsolute(p) ? p : resolve(cwd, p);
  const rel = relative(cwd, abs);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Path escapes the working directory: ${p}`);
  }
  return abs;
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
