import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

// Every package's tests get a throwaway ARTERM_HOME. Without one they write the
// DEVELOPER's own `~/.arterm` — not in theory: a single `agent.test.ts` case
// spooled a real file into `~/.arterm/tool-output`, because `spoolDir()` is
// `join(ARTERM_HOME, "tool-output")` and nothing here redirected it.
//
// It has to be an env var set HERE rather than in a test body: `ARTERM_HOME` is
// resolved once when `@arterm/core`'s config module loads, which is before any
// test line runs. `configIsolation.test.ts` asserts that every package with
// tests has this, because the rule is what holds — not any one package.
export default defineConfig({
  test: {
    env: {
      ARTERM_HOME: join(tmpdir(), "arterm-vitest-home"),
    },
  },
});
