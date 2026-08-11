import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * `app.ts` hardcodes `VERSION` rather than importing `package.json`, and that
 * is deliberate: tsup bundles this package into one self-contained file, so a
 * runtime read of `package.json` would resolve against wherever the binary
 * happens to sit — which for a global install is not next to its own manifest.
 *
 * The cost of that choice is two numbers that must agree and nothing making
 * them. A release that bumps the manifest and forgets the constant ships a
 * binary whose `--version` and status bar both lie, and every symptom of that
 * is a bug report about the WRONG build. This is the something that makes them
 * agree; it is why the constant is allowed to stay hardcoded.
 */
const HERE = dirname(fileURLToPath(import.meta.url));

describe("the version the CLI reports", () => {
  it("matches this package's manifest", () => {
    const manifest = JSON.parse(readFileSync(join(HERE, "..", "package.json"), "utf8")) as {
      version: string;
    };
    // Searched rather than read from one path: the constant has already moved
    // once (`main.ts` → `app.ts` when the entry point was split), and a test
    // that pins the FILE would have gone green by finding nothing to check.
    const declarations = readdirSync(HERE)
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
      .map((f) => /^const VERSION = "([^"]+)";$/m.exec(readFileSync(join(HERE, f), "utf8"))?.[1])
      .filter((v): v is string => v !== undefined);

    expect(declarations, "no file declares VERSION the way this test reads it").toHaveLength(1);
    expect(declarations[0]).toBe(manifest.version);
  });
});
