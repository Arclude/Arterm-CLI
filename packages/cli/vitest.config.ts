import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

// `buildSession().persist()` writes the config — that is its job, and this
// package is the one that builds real sessions in tests. Without a redirect it
// writes the DEVELOPER'S `~/.arterm/config.json`: `processE2e.test.ts` builds a
// session from `defaultConfig()` and persists it, which quietly reset a real
// config's provider/model/permissions to the defaults. Everything else in the
// file survived, so it still looked correct — and the next run went to a dead
// Ollama while `openaiCompatHost` still named the real endpoint.
//
// It has to be an env var set HERE rather than in a test body: `ARTERM_HOME` is
// resolved once when `@arterm/core`'s config module loads, which is before any
// test line runs.
export default defineConfig({
  test: {
    env: {
      ARTERM_HOME: join(tmpdir(), "arterm-vitest-home"),
    },
  },
});
