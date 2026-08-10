import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

/**
 * The workspace root has a vitest config for one reason: without it, running
 * vitest FROM THE ROOT loads no package config at all — and every safety those
 * files carry is a per-package setting.
 *
 * `pnpm -r test` is the supported command and runs each package with its own
 * config. But `pnpm exec vitest run` from the root is the same thing to look
 * at, resolves test files across every package, and prints a normal-looking
 * green summary. It is also unprotected, and it cost a real config: the
 * developer's `~/.arterm/config.json` came back as `{}`. That is exactly what
 * `saveConfig` should write for a session built from `defaultConfig()` — the
 * delta of a config equal to the defaults is empty — so the write was correct
 * code doing its job in the wrong HOME.
 *
 * This is the fourth instance of one mistake (`config.json`, `status/`,
 * `tool-output/`, and now the root), which is why the fix is a default rather
 * than a rule to remember: the dangerous command is now safe, instead of merely
 * discouraged.
 *
 * `packages/cli/src/configIsolation.test.ts` asserts this file keeps the
 * redirect, the same way it asserts each package's does.
 */
export default defineConfig({
  test: {
    env: {
      // Never the developer's real ~/.arterm — see the note above.
      ARTERM_HOME: join(tmpdir(), "arterm-vitest-home"),
      // Frame assertions in the TUI's render tests match plain substrings; a
      // colour-forcing variable threads ANSI codes through every frame and
      // fails tests that have nothing to do with styling.
      FORCE_COLOR: "0",
      CLICOLOR_FORCE: "0",
    },
  },
});
