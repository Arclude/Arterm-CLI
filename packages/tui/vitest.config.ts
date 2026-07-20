import { defineConfig } from "vitest/config";

// Frame assertions in the render tests match plain substrings ("› hello
// history"); a FORCE_COLOR/CLICOLOR_FORCE leaking in from the caller's shell
// would thread ANSI codes through every frame and break them. Pin colors off —
// the TUI's styling is not what these tests assert.
export default defineConfig({
  test: {
    env: {
      FORCE_COLOR: "0",
      CLICOLOR_FORCE: "0",
    },
  },
});
