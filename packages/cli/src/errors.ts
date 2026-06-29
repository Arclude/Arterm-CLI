/**
 * A "known", expected failure the user can act on — a bad flag, an unreachable
 * service, an unknown provider. The top-level handler prints only its `message`
 * (no stack), so the CLI reads like a tool rather than a crash. Unexpected
 * errors still surface their stack (or a hint to set ARTERM_DEBUG).
 */
export class ArtermUserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtermUserError";
  }
}

/**
 * Print a clean, single-line error to stderr and exit. Use for expected,
 * actionable failures discovered outside the top-level catch (e.g. inside a
 * command action). Equivalent to `throw new ArtermUserError(...)` but terminal.
 */
export function fail(message: string, code = 1): never {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}
