/**
 * Turning argv back into one shell word-list, for the sandbox seam only.
 *
 * The sandbox runtime's entry point takes a COMMAND STRING and returns argv
 * (`bwrap … sh -c <command>`), because it was built for `bash`, where a string
 * is what the user wrote. Tools that assemble argv themselves — `test`,
 * `install`, `logs` — have the opposite shape and have to hand one over.
 *
 * That is the only place quoting is allowed to matter, and it is why this is a
 * separate, tested file rather than a template literal at the call site. The
 * arguments being quoted include model-supplied ones (a test path, a package
 * name), so a quoting bug here is a shell injection: `test({path: "x; rm -rf
 * ~"})` reaches `sh -c` as two commands instead of one path. Single-quote
 * wrapping is used because it has exactly one escape to get right — inside
 * single quotes a POSIX shell interprets nothing at all, not `$`, not a
 * backslash, not a newline.
 *
 * Unsandboxed spawns do NOT go through this: they pass argv to execa with
 * `shell: false`, where no shell exists to quote for.
 */

/** Characters that need no quoting in any POSIX shell. */
const BARE = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** One argument, safe to paste into a POSIX shell command line. */
export function shQuote(arg: string): string {
  if (arg === "") return "''";
  if (BARE.test(arg)) return arg;
  // Close the quote, emit an escaped quote, reopen: 'it'\''s'.
  return `'${arg.replaceAll("'", `'\\''`)}'`;
}

/** An argv joined into a single command string. */
export function shJoin(argv: readonly string[]): string {
  return argv.map(shQuote).join(" ");
}
