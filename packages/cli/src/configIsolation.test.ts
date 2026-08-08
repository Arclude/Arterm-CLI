import { homedir, tmpdir } from "node:os";
import { ARTERM_HOME } from "@arterm/core";
import { describe, expect, it } from "vitest";

/**
 * The tests in this package build REAL sessions and call `persist()`, which
 * writes `config.json`. That is correct behaviour being tested — the danger is
 * only ever WHERE it writes.
 *
 * It wrote the developer's own `~/.arterm/config.json`, and the way that failed
 * is the reason this guard is a test rather than a comment: nothing broke, and
 * nothing said anything. A real config's provider/model/permissions were reset
 * to `defaultConfig()`'s while every other field survived, so the file still
 * read as a working config — with `openaiCompatHost` still naming the live
 * endpoint next to `provider: "ollama"`. The next run went to an Ollama that
 * was not running, and the error surfaced three layers away as a team leader
 * that "proposed no work".
 *
 * `vitest.config.ts` redirects it. This asserts the redirect is still there,
 * because deleting that file is a one-line change whose only symptom is
 * somebody's config quietly changing under them days later.
 */
describe("tests never write the developer's real config", () => {
  it("resolves ARTERM_HOME to a throwaway directory, not $HOME/.arterm", () => {
    expect(ARTERM_HOME.startsWith(tmpdir())).toBe(true);
    expect(ARTERM_HOME).not.toBe(`${homedir()}/.arterm`);
  });
});
