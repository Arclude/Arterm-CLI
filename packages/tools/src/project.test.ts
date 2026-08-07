import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxRunner } from "@arterm/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { logsTool } from "./logs.js";
import { runProjectCommand } from "./project.js";
import {
  auditTool,
  installTool,
  lintTool,
  outdatedTool,
  testTool,
  typecheckTool,
} from "./registry.js";
import { shJoin, shQuote } from "./shellQuote.js";

let dir: string;
const ctx = () => ({ cwd: dir });

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), "arterm-project-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

/** A package.json whose scripts are node one-liners, so no toolchain is needed. */
async function pkg(scripts: Record<string, string>) {
  await fs.writeFile(join(dir, "package.json"), JSON.stringify({ name: "probe", scripts }));
}

/** A script that prints one environment variable, or "absent". */
const show = (name: string) => `node -e "console.log(process.env.${name} ?? 'absent')"`;

describe("project commands and the session's credentials", () => {
  beforeEach(() => {
    process.env.ARTERM_TEST_API_KEY = "sk-leaked";
    process.env.ARTERM_TEST_PLAIN = "visible";
  });
  afterEach(() => {
    Reflect.deleteProperty(process.env, "ARTERM_TEST_API_KEY");
    Reflect.deleteProperty(process.env, "ARTERM_TEST_PLAIN");
  });

  it("withholds a credential-named variable from the project's own script", async () => {
    // The hole this closes: `test`, `lint` and `format` shipped spawning with
    // the agent's environment, so a repository's test script — and every
    // dependency's postinstall under `install` — ran holding the user's key.
    await pkg({ lint: show("ARTERM_TEST_API_KEY") });
    const res = await lintTool.execute({}, ctx());
    expect(res.output.trim().split("\n").pop()).toBe("absent");
  });

  it("passes the rest of the environment through, PATH included", async () => {
    await pkg({ lint: show("ARTERM_TEST_PLAIN") });
    expect((await lintTool.execute({}, ctx())).output.trim().split("\n").pop()).toBe("visible");
    await pkg({ lint: show("PATH") });
    expect((await lintTool.execute({}, ctx())).output.trim().split("\n").pop()).not.toBe("absent");
  });

  it("hands it over when the session switched the scrub off", async () => {
    await pkg({ lint: show("ARTERM_TEST_API_KEY") });
    const res = await lintTool.execute({}, { ...ctx(), credentials: { scrub: false } });
    expect(res.output.trim().split("\n").pop()).toBe("sk-leaked");
  });

  it("names what was withheld on a FAILING command, never its value", async () => {
    await pkg({
      test: `node -e "console.error('need ARTERM_TEST_API_KEY'); process.exit(3)"`,
    });
    const res = await testTool.execute({}, ctx());
    expect(res.isError).toBe(true);
    expect(res.output).toContain("credentials.allow");
    expect(res.output).not.toContain("sk-leaked");
  });

  it("stays quiet on a failure the environment had nothing to do with", async () => {
    await pkg({ test: `node -e "process.exit(3)"` });
    const res = await testTool.execute({}, ctx());
    expect(res.isError).toBe(true);
    expect(res.output).not.toContain("credentials.allow");
  });
});

describe("project commands inside a sandbox", () => {
  const fakeSandbox = (overrides?: Partial<SandboxRunner>): SandboxRunner => ({
    describe: "fake",
    async wrap() {
      return {
        argv: ["node", "-e", "console.log('ran-inside:' + (process.env.INSIDE ?? 'no'))"],
        env: { ...process.env, INSIDE: "1" },
      };
    },
    release() {},
    ...overrides,
  });

  it("runs the wrapped argv rather than the raw command", async () => {
    await pkg({ lint: `node -e "console.log('unconfined')"` });
    const res = await lintTool.execute({}, { ...ctx(), sandbox: fakeSandbox() });
    expect(res.output.trim()).toBe("ran-inside:1");
    expect(res.output).not.toContain("unconfined");
  });

  it("turns a refusal into an error result instead of running unconfined", async () => {
    const marker = join(dir, "escaped.txt");
    await pkg({
      lint: `node -e "require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')"`,
    });
    const res = await lintTool.execute(
      {},
      {
        ...ctx(),
        sandbox: fakeSandbox({
          wrap: async () => {
            throw new Error("cwd is outside the sandbox boundary");
          },
        }),
      },
    );
    expect(res.isError).toBe(true);
    expect(res.output).toContain("Sandbox refused");
    await expect(fs.access(marker)).rejects.toThrow();
  });

  it("scrubs the sandboxed path too, keeping the wrapper's own variables", async () => {
    // execa merges `env` into process.env by default, so passing the wrapper's
    // map alone would hand the host's keys through beside it.
    process.env.ARTERM_TEST_API_KEY = "sk-leaked";
    try {
      await pkg({ lint: "true" });
      const res = await lintTool.execute(
        {},
        {
          ...ctx(),
          sandbox: fakeSandbox({
            async wrap() {
              return {
                argv: [
                  "node",
                  "-e",
                  "console.log([process.env.INSIDE ?? 'no-wrap', process.env.ARTERM_TEST_API_KEY ?? 'absent'].join(' '))",
                ],
                env: { ...process.env, INSIDE: "1" },
              };
            },
          }),
        },
      );
      expect(res.output.trim()).toBe("1 absent");
    } finally {
      Reflect.deleteProperty(process.env, "ARTERM_TEST_API_KEY");
    }
  });

  it("releases per-command state even when the command fails", async () => {
    let released = 0;
    await pkg({ lint: "true" });
    const res = await lintTool.execute(
      {},
      {
        ...ctx(),
        sandbox: fakeSandbox({
          async wrap() {
            return { argv: ["node", "-e", "process.exit(3)"], env: { ...process.env } };
          },
          release: () => void released++,
        }),
      },
    );
    expect(res.isError).toBe(true);
    expect(released).toBe(1);
  });
});

describe("output is no longer cut from the front", () => {
  it("keeps the end of a failing run, where the failure is", async () => {
    // The old helper sliced the first 16 KB, which for a test run is the banner
    // and none of the failures.
    const noise = "x".repeat(200);
    await pkg({
      test: `node -e "for (let i=0;i<200;i++) console.log('${noise}'); console.log('THE FAILURE'); process.exit(1)"`,
    });
    const res = await testTool.execute({}, ctx());
    expect(res.isError).toBe(true);
    expect(res.output).toContain("THE FAILURE");
  });
});

describe("typecheckTool", () => {
  it("prefers the project's own script — in a monorepo it knows about the packages", async () => {
    await pkg({ typecheck: `node -e "console.log('script ran')"` });
    const res = await typecheckTool.execute({}, ctx());
    expect(res.output).toContain("script ran");
  });

  it("accepts the hyphenated spelling too", async () => {
    await pkg({ "type-check": `node -e "console.log('hyphenated')"` });
    expect((await typecheckTool.execute({}, ctx())).output).toContain("hyphenated");
  });

  it("says what is missing rather than failing obscurely", async () => {
    await pkg({});
    const res = await typecheckTool.execute({}, ctx());
    expect(res.isError).toBe(true);
    expect(res.output).toContain("nothing to type-check");
  });
});

describe("installTool", () => {
  it("refuses a 'package name' the package manager would read as a flag", async () => {
    // `--registry=http://attacker` repoints where the code comes from.
    await pkg({});
    const res = await installTool.execute(
      { packages: ["--registry=http://attacker.example"] },
      ctx(),
    );
    expect(res.isError).toBe(true);
    expect(res.output).toContain("reads as a flag");
  });

  it("refuses a name with whitespace, which would become two arguments", async () => {
    await pkg({});
    const res = await installTool.execute({ packages: ["lodash --global"] }, ctx());
    expect(res.isError).toBe(true);
    expect(res.output).toContain("whitespace");
  });

  it("previews what it would add, so the prompt says more than 'install'", () => {
    expect(installTool.preview?.({ packages: ["zod"], dev: true })).toContain("(dev) zod");
    expect(installTool.preview?.({})).toBe("install project dependencies");
  });

  it("is gated harder than an edit — it runs code nobody named", () => {
    expect(installTool.riskTier).toBe("destructive");
    expect(installTool.permission).toBe("ask");
  });
});

describe("audit and outdated", () => {
  // `npm audit` exits 1 because it FOUND something, and `npm outdated` exits 1
  // because something is outdated. Reporting those as tool errors teaches the
  // model that the command is broken every time it does its job. Tested against
  // the runner directly rather than against npm, which needs a registry and a
  // lockfile to say anything at all.
  it("a reporting command's non-zero exit is data, not an error", async () => {
    const res = await runProjectCommand(
      "node",
      ["-e", "console.log('3 vulnerabilities'); process.exit(1)"],
      ctx(),
      { exitCodeIsData: true },
    );
    expect(res.isError).toBeFalsy();
    expect(res.output).toContain("3 vulnerabilities");
    expect(res.output).toContain("exit code 1");
  });

  it("but a silent non-zero exit is still an error — nothing was reported", async () => {
    const res = await runProjectCommand("node", ["-e", "process.exit(1)"], ctx(), {
      exitCodeIsData: true,
    });
    expect(res.isError).toBe(true);
  });

  it("an ordinary command's non-zero exit stays an error", async () => {
    const res = await runProjectCommand(
      "node",
      ["-e", "console.log('boom'); process.exit(1)"],
      ctx(),
    );
    expect(res.isError).toBe(true);
  });

  it("both report tools are read-only and need no arguments", () => {
    for (const tool of [auditTool, outdatedTool]) {
      expect(tool.category).toBe("read");
      expect(tool.permission).toBe("allow");
      expect(Object.keys(tool.parameters.properties as object)).toHaveLength(0);
    }
  });
});

describe("logsTool", () => {
  it("returns the END of a file, which is where a log's answer is", async () => {
    const lines = Array.from({ length: 500 }, (_, i) => `line ${i}`);
    await fs.writeFile(join(dir, "app.log"), `${lines.join("\n")}\n`);
    const res = await logsTool.execute({ target: "app.log", lines: 5 }, ctx());
    expect(res.output).toContain("line 498");
    expect(res.output).not.toContain("line 100");
  });

  it("reads the tail of a file too large to read", async () => {
    // The gap `read` cannot cover: it pages FORWARD from a line number, so the
    // end of a big log is reachable only by knowing its length first.
    const big = `${"filler line to make this large\n".repeat(80_000)}THE LAST LINE\n`;
    await fs.writeFile(join(dir, "big.log"), big);
    const res = await logsTool.execute({ target: "big.log", lines: 2 }, ctx());
    expect(res.output).toContain("THE LAST LINE");
    expect(res.output).toContain("final");
  });

  it("filters, and says the view is filtered", async () => {
    await fs.writeFile(join(dir, "a.log"), "info: ok\nERROR: bad\ninfo: ok\nERROR: worse\n");
    const res = await logsTool.execute({ target: "a.log", filter: "^ERROR" }, ctx());
    expect(res.output).toContain("ERROR: bad");
    expect(res.output).not.toContain("info: ok");
    expect(res.output).toContain("matched");
  });

  it("says so when the filter matched nothing, instead of returning empty", async () => {
    await fs.writeFile(join(dir, "a.log"), "all fine\n");
    const res = await logsTool.execute({ target: "a.log", filter: "PANIC" }, ctx());
    expect(res.output).toContain("No line");
  });

  it("rejects an invalid filter regex with the reason", async () => {
    await fs.writeFile(join(dir, "a.log"), "x\n");
    const res = await logsTool.execute({ target: "a.log", filter: "([" }, ctx());
    expect(res.isError).toBe(true);
    expect(res.output).toContain("Invalid filter regex");
  });

  it("confines a log path like every other file-taking tool", async () => {
    await expect(logsTool.execute({ target: "../../etc/hosts" }, ctx())).rejects.toThrow(/escapes/);
  });
});

describe("shell quoting for the sandbox seam", () => {
  it("leaves ordinary words alone", () => {
    expect(shJoin(["pnpm", "run", "test", "src/a.test.ts"])).toBe("pnpm run test src/a.test.ts");
  });

  it("neutralises a command separator hidden in an argument", () => {
    // `test({path: "x; rm -rf ~"})` must reach `sh -c` as one path.
    const cmd = shJoin(["pnpm", "test", "x; rm -rf ~"]);
    expect(cmd).toBe("pnpm test 'x; rm -rf ~'");
  });

  it("escapes an embedded single quote, the only character that can close the wrapper", () => {
    expect(shQuote("it's")).toBe(`'it'\\''s'`);
  });

  it("quotes the empty string rather than dropping the argument", () => {
    expect(shQuote("")).toBe("''");
  });

  it("neutralises substitutions and newlines", () => {
    expect(shQuote("$(whoami)")).toBe("'$(whoami)'");
    expect(shQuote("`id`")).toBe("'`id`'");
    expect(shQuote("a\nb")).toBe("'a\nb'");
  });
});
