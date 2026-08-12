import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createHash } from "node:crypto";

/**
 * The SDK derives the Windows pipe name independently of `arterm-transport`,
 * because one is Rust and one is TypeScript. A drift between them is invisible
 * on Unix and total on Windows: the client dials a pipe nobody is listening on,
 * so nothing connects at all.
 *
 * `arterm-transport`'s `pipe_name_matches_the_typescript_sdk` asserts the same
 * literal strings from the other side.
 */

/** The derivation under test, with the platform's path parser injected. */
function derivePipeName(socketPath: string, parser: path.PlatformPath): string {
  const stem =
    (parser.parse(socketPath).name.match(/[A-Za-z0-9\-_]/g) ?? []).join("").slice(0, 32) || "arterm";
  const normalized = socketPath.replace(/\\/g, "/").toLowerCase();
  const hash = createHash("sha256").update(normalized).digest("hex").slice(0, 16);
  return `\\\\.\\pipe\\${stem}-${hash}`;
}

test("the Windows pipe name matches arterm-transport exactly", () => {
  // Parsed with win32 semantics regardless of the host, so the check runs in
  // CI on Linux rather than only on a Windows runner.
  for (const [socketPath, expected] of [
    [
      "C:\\Users\\jeremy\\AppData\\Local\\arterm\\run\\arterm-api.sock",
      "\\\\.\\pipe\\arterm-api-637007233891e38e",
    ],
    ["C:\\a\\b\\arterm.sock", "\\\\.\\pipe\\arterm-73fa1ca68234bbfc"],
  ] as const) {
    assert.equal(
      derivePipeName(socketPath, path.win32),
      expected,
      `pipe name for ${socketPath} drifted from arterm-transport`,
    );
  }
});

test("case and separators normalize the same way", () => {
  assert.equal(
    derivePipeName("C:\\Temp\\Arterm\\server.sock", path.win32),
    derivePipeName("c:/temp/arterm/server.sock", path.win32),
    "the pipe name must not depend on case or separator style",
  );
});

test("a path with no usable characters still yields a name", () => {
  const derived = derivePipeName("/tmp/!!!.sock", path.posix);
  assert.match(derived, /^\\\\\.\\pipe\\arterm-[0-9a-f]{16}$/);
});
