import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

// Frame assertions in the render tests match plain substrings ("› hello
// history"); a FORCE_COLOR/CLICOLOR_FORCE leaking in from the caller's shell
// would thread ANSI codes through every frame and break them. Pin colors off —
// the TUI's styling is not what these tests assert.
//
// ARTERM_HOME is the separate rule every package obeys: without a throwaway one
// the tests write the DEVELOPER's own `~/.arterm`. Having a config already and
// still missing this is exactly how the gap survived — the file existed, so
// nobody looked inside it.
export default defineConfig({
  test: {
    env: {
      FORCE_COLOR: "0",
      CLICOLOR_FORCE: "0",
      ARTERM_HOME: join(tmpdir(), "arterm-vitest-home"),
    },
  },
});
