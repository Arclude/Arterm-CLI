import { describe, expect, it } from "vitest";
import { scrubEnv, withheldNote } from "./credentials.js";

const names = (env: Record<string, string | undefined>) => Object.keys(env).sort();

describe("scrubEnv", () => {
  it("withholds the credentials Arterm itself puts in the environment", () => {
    const { env, withheld } = scrubEnv({
      ANTHROPIC_API_KEY: "sk-ant-real",
      OPENAI_API_KEY: "sk-real",
      ARTERM_SECRET: "passphrase",
      PATH: "/usr/bin",
    });
    expect(names(env)).toEqual(["PATH"]);
    expect(withheld).toEqual(["ANTHROPIC_API_KEY", "ARTERM_SECRET", "OPENAI_API_KEY"]);
    // The value never appears anywhere in the result — names are the report.
    expect(JSON.stringify({ env, withheld })).not.toContain("sk-ant-real");
  });

  it("withholds by name shape, not by a fixed list of vendors", () => {
    const { withheld } = scrubEnv({
      GITHUB_TOKEN: "x",
      AWS_SECRET_ACCESS_KEY: "x",
      AWS_ACCESS_KEY_ID: "x",
      AWS_SESSION_TOKEN: "x",
      DB_PASSWORD: "x",
      SOME_VENDOR_CLIENT_SECRET: "x",
      DEPLOY_KEY: "x",
      SESSION_COOKIE: "x",
    });
    expect(withheld).toHaveLength(8);
  });

  it("leaves the toolchain's own environment alone", () => {
    // Every one of these is a name a looser pattern would have swallowed, and
    // each breaks something real: the shell, the desktop session, git over SSH,
    // a HuggingFace run. A control that breaks these gets switched off.
    const base = {
      PATH: "/usr/bin",
      HOME: "/home/dev",
      SSH_AUTH_SOCK: "/run/user/1000/keyring/ssh",
      XDG_SESSION_TYPE: "wayland",
      XDG_SESSION_ID: "2",
      GNOME_KEYRING_CONTROL: "/run/user/1000/keyring",
      SSH_ASKPASS: "/usr/bin/ksshaskpass",
      KEYBOARD_LAYOUT: "tr",
      TOKENIZERS_PARALLELISM: "false",
      npm_config_registry: "https://registry.npmjs.org/",
    };
    const { env, withheld } = scrubEnv(base);
    expect(withheld).toEqual([]);
    expect(names(env)).toEqual(names(base));
  });

  it("passes an allowlisted name through and withholds an extra denied one", () => {
    const { env, withheld } = scrubEnv(
      { GITHUB_TOKEN: "gh", DATABASE_URL: "postgres://u:p@h/db", PATH: "/usr/bin" },
      { allow: ["github_token"], deny: ["DATABASE_URL"] },
    );
    expect(names(env)).toEqual(["GITHUB_TOKEN", "PATH"]);
    expect(withheld).toEqual(["DATABASE_URL"]);
  });

  it("resolves an overlapping allow/deny closed", () => {
    const { withheld } = scrubEnv(
      { GITHUB_TOKEN: "gh" },
      { allow: ["GITHUB_TOKEN"], deny: ["GITHUB_TOKEN"] },
    );
    expect(withheld).toEqual(["GITHUB_TOKEN"]);
  });

  it("scrubs when given NO settings at all — the unwired path is not the open one", () => {
    expect(scrubEnv({ OPENAI_API_KEY: "x" }).withheld).toEqual(["OPENAI_API_KEY"]);
    expect(scrubEnv({ OPENAI_API_KEY: "x" }, {}).withheld).toEqual(["OPENAI_API_KEY"]);
  });

  it("hands everything over only when scrub is switched off deliberately", () => {
    const { env, withheld } = scrubEnv({ OPENAI_API_KEY: "x" }, { scrub: false });
    expect(names(env)).toEqual(["OPENAI_API_KEY"]);
    expect(withheld).toEqual([]);
  });

  it("does not read or mutate the caller's environment object", () => {
    const base = { OPENAI_API_KEY: "x", PATH: "/usr/bin" };
    scrubEnv(base);
    expect(names(base)).toEqual(["OPENAI_API_KEY", "PATH"]);
  });
});

describe("withheldNote", () => {
  it("says nothing when nothing was withheld", () => {
    expect(withheldNote([], "anything")).toBeUndefined();
  });

  it("stays quiet when the failure never mentioned the variable", () => {
    // The case that would otherwise append a credentials line to every failing
    // test run in a session that happens to have an API key in its environment.
    expect(withheldNote(["ANTHROPIC_API_KEY"], "pnpm -r test\n2 tests failed")).toBeUndefined();
  });

  it("speaks up when the command or its output names the variable", () => {
    const fromOutput = withheldNote(
      ["GITHUB_TOKEN"],
      "gh pr create\nerror: GITHUB_TOKEN is not set",
    ) as string;
    expect(fromOutput).toContain("GITHUB_TOKEN");
    expect(fromOutput).toContain("credentials.allow");
    expect(withheldNote(["GITHUB_TOKEN"], "echo $GITHUB_TOKEN\n")).toBeDefined();
  });

  it("reports only the names the evidence points at", () => {
    const note = withheldNote(["A_TOKEN", "B_TOKEN"], "cmd\nB_TOKEN missing") as string;
    expect(note).toContain("B_TOKEN");
    expect(note).not.toContain("A_TOKEN");
  });

  it("caps the list rather than pasting a whole environment into the transcript", () => {
    const note = withheldNote(["A", "B", "C", "D"], "A B C D", 2) as string;
    expect(note).toContain("A, B");
    expect(note).toContain("+2 more");
    expect(note).not.toContain("C,");
  });
});
