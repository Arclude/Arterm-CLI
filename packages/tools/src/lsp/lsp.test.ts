import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// The waits under test are real seconds by default; a fixture answers or does
// not answer immediately, so there is nothing to learn from sitting them out.
process.env.ARTERM_LSP_REQUEST_MS = "800";
process.env.ARTERM_LSP_DIAGNOSTICS_MS = "500";
process.env.ARTERM_LSP_INIT_MS = "8000";
import { rmWithRetry } from "../testTmp.js";
import { LspClient, uriKey, uriOf } from "./client.js";
import { FrameReader, frame } from "./protocol.js";
import { installHint, resolveServerBinary, serverFor } from "./servers.js";
import {
  applyTextEdits,
  disposeLspClients,
  lspCompletionTool,
  lspDefinitionTool,
  lspDiagnosticsTool,
  lspRenameTool,
} from "./tools.js";

const FAKE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-lsp.mjs");

/** The fake server, spawned through node so no executable bit is needed. */
const fakeServer = (mode: string) => ({
  spec: {
    command: "fake-lsp",
    args: [FAKE, "--mode", mode],
    install: "(the test fixture)",
    languageId: "typescript",
  },
  binary: process.execPath,
});

let dir: string;
const ctx = () => ({ cwd: dir });

beforeEach(async () => {
  // Canonical, not just unique. A real session's cwd comes from `process.cwd()`,
  // which Windows reports in its long form, while `mkdtemp` hands back the 8.3
  // short one (`C:\Users\RUNNER~1\…`). The language server answers with paths it
  // canonicalised itself, so the tool could not shorten them against a root
  // spelled differently and reported an absolute path where the test wanted
  // `a.ts`. Resolving here makes both sides talk about the same directory.
  dir = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "arterm-lsp-")));
});
afterEach(async () => {
  await disposeLspClients();
  // The server is a child process; its handles on `dir` outlive its exit.
  await rmWithRetry(dir);
});

describe("frame reading", () => {
  const read = (reader: FrameReader, text: string) => reader.push(Buffer.from(text, "utf8"));

  it("reads one complete frame", () => {
    const reader = new FrameReader();
    const messages = read(reader, frame({ jsonrpc: "2.0", id: 1, result: "ok" }));
    expect(messages).toHaveLength(1);
    expect(messages[0]?.result).toBe("ok");
  });

  it("measures BYTES, not characters", () => {
    // A diagnostic naming a CJK identifier is longer in bytes than in
    // characters. A character-counting reader desynchronises from that message
    // on, and every later reply is garbage — which reads as a crashed server.
    const reader = new FrameReader();
    const first = { jsonrpc: "2.0" as const, id: 1, result: "識別子とem—dash" };
    const second = { jsonrpc: "2.0" as const, id: 2, result: "after" };
    const messages = read(reader, frame(first) + frame(second));
    expect(messages).toHaveLength(2);
    expect(messages[0]?.result).toBe("識別子とem—dash");
    expect(messages[1]?.result).toBe("after");
  });

  it("waits for a frame split across chunks", () => {
    const reader = new FrameReader();
    const whole = frame({ jsonrpc: "2.0", id: 1, result: "split" });
    const cut = Math.floor(whole.length / 2);
    expect(read(reader, whole.slice(0, cut))).toHaveLength(0);
    const rest = read(reader, whole.slice(cut));
    expect(rest[0]?.result).toBe("split");
  });

  it("returns every message a single chunk completed", () => {
    const reader = new FrameReader();
    const three = [1, 2, 3].map((id) => frame({ jsonrpc: "2.0", id, result: id })).join("");
    expect(read(reader, three).map((m) => m.result)).toEqual([1, 2, 3]);
  });

  it("resynchronises past a header with no length instead of spinning", () => {
    const reader = new FrameReader();
    const messages = read(
      reader,
      `Nonsense: 1\r\n\r\n${frame({ jsonrpc: "2.0", id: 7, result: "after" })}`,
    );
    expect(messages[0]?.result).toBe("after");
  });

  it("drops a malformed body without losing the connection", () => {
    const reader = new FrameReader();
    const bad = "Content-Length: 3\r\n\r\n{{{";
    const messages = read(reader, bad + frame({ jsonrpc: "2.0", id: 2, result: "fine" }));
    expect(messages).toHaveLength(1);
    expect(messages[0]?.result).toBe("fine");
  });
});

describe("applyTextEdits", () => {
  it("applies back-to-front so earlier offsets stay valid", () => {
    // Front-to-back, the second edit lands at a shifted position.
    const text = "const alpha = alpha + 1;";
    const edits = [
      {
        range: { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } },
        newText: "renamedSymbol",
      },
      {
        range: { start: { line: 0, character: 14 }, end: { line: 0, character: 19 } },
        newText: "renamedSymbol",
      },
    ];
    expect(applyTextEdits(text, edits)).toBe("const renamedSymbol = renamedSymbol + 1;");
  });

  it("handles edits across lines", () => {
    const text = "alpha\nbeta\ngamma";
    const edits = [
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, newText: "A" },
      { range: { start: { line: 2, character: 0 }, end: { line: 2, character: 5 } }, newText: "C" },
    ];
    expect(applyTextEdits(text, edits)).toBe("A\nbeta\nC");
  });
});

describe("finding a server", () => {
  it("says what to install when there is none", () => {
    const hint = installHint([
      {
        command: "pyright-langserver",
        args: [],
        install: "npm i -g pyright",
        languageId: "python",
      },
    ]);
    expect(hint).toContain("npm i -g pyright");
    // Never a dead end: the weaker tools still answer.
    expect(hint).toContain("typecheck");
  });

  it("prefers the project's own copy over whatever is on PATH", async () => {
    // A repo that pins a language server means that version, not the
    // developer's global one, which may be a different compiler entirely.
    const bin = join(dir, "node_modules", ".bin");
    await fs.mkdir(bin, { recursive: true });
    const local = join(bin, "typescript-language-server");
    await fs.writeFile(local, "#!/bin/sh\n");
    await fs.chmod(local, 0o755);
    expect(await resolveServerBinary("typescript-language-server", dir)).toBe(local);
  });

  it("always returns an ABSOLUTE path, even from a relative PATH entry", async () => {
    // pnpm puts a bare `node_modules/.bin` on PATH. A relative result resolves
    // against the test process's cwd here and against the project root when the
    // server is spawned — two different directories. The only symptom was a
    // server that closed its output the instant it started.
    const bin = join(dir, "bin");
    await fs.mkdir(bin, { recursive: true });
    const exe = join(bin, "fake-server-binary");
    await fs.writeFile(exe, "#!/bin/sh\n");
    await fs.chmod(exe, 0o755);

    const path = process.env.PATH;
    const cwd = process.cwd();
    try {
      process.chdir(dir);
      process.env.PATH = "bin";
      const found = await resolveServerBinary("fake-server-binary", dir);
      expect(found).toBeDefined();
      expect(isAbsolute(found as string)).toBe(true);
    } finally {
      process.chdir(cwd);
      process.env.PATH = path;
    }
  });

  it("reports the candidates for a language with none installed", async () => {
    const found = await serverFor("python", dir);
    if ("missing" in found) {
      expect(found.missing.map((s) => s.command)).toEqual(["pyright-langserver", "pylsp"]);
    } else {
      expect(found.server.spec.command).toMatch(/pyright|pylsp/);
    }
  });
});

describe("the client, against a server that misbehaves", () => {
  it("initializes and answers a definition", async () => {
    const client = await LspClient.start(fakeServer("ok"), dir);
    const uri = await client.didOpen(join(dir, "a.ts"), "const alpha = 1;\n", "typescript");
    const result = (await client.definition(uri, { line: 0, character: 6 })) as Array<{
      range: { start: { line: number } };
    }>;
    expect(result[0]?.range.start.line).toBe(4);
    await client.dispose();
  });

  it("times out rather than hanging the turn forever", async () => {
    // A server that stops answering is the common failure — it is indexing, or
    // confused by a half-written file. A tool call that never returns is worse
    // than one that says so, because the turn simply ends.
    const client = await LspClient.start(fakeServer("silent"), dir);
    const uri = await client.didOpen(join(dir, "a.ts"), "x\n", "typescript");
    await expect(client.definition(uri, { line: 0, character: 0 })).rejects.toThrow(
      /did not answer within/,
    );
    await client.dispose();
  });

  it("settles pending requests when the server dies", async () => {
    const client = await LspClient.start(fakeServer("crash"), dir);
    const uri = await client.didOpen(join(dir, "a.ts"), "x\n", "typescript");
    await expect(client.definition(uri, { line: 0, character: 0 })).rejects.toThrow();
    await client.dispose();
  });
});

describe("the tools", () => {
  const write = async (rel: string, body: string) => {
    await fs.writeFile(join(dir, rel), body);
    return join(dir, rel);
  };

  /** Point the tools at the fake by planting it as the project's own server. */
  const plantFake = async (mode: string) => {
    const bin = join(dir, "node_modules", ".bin");
    await fs.mkdir(bin, { recursive: true });
    const shim = join(bin, "typescript-language-server");
    await fs.writeFile(shim, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" --mode ${mode}\n`);
    await fs.chmod(shim, 0o755);
  };

  it("says what to install when no server is present", async () => {
    // PATH is emptied deliberately: pnpm puts the workspace's own
    // node_modules/.bin on it, so on THIS machine a server is always findable
    // and the test would assert nothing about the case it is named for.
    const path = process.env.PATH;
    process.env.PATH = "";
    try {
      await write("a.ts", "const alpha = 1;\n");
      const res = await lspDefinitionTool.execute({ path: "a.ts", symbol: "alpha" }, ctx());
      expect(res.isError).toBe(true);
      expect(res.output).toContain("npm i -g typescript-language-server");
    } finally {
      process.env.PATH = path;
    }
  });

  it("resolves a definition by symbol name", async () => {
    await plantFake("ok");
    await write("a.ts", "const alpha = 1;\n");
    const res = await lspDefinitionTool.execute({ path: "a.ts", symbol: "alpha" }, ctx());
    expect(res.isError).toBeFalsy();
    expect(res.output).toContain("a.ts:5:10");
  });

  it("says a symbol is absent rather than guessing a position", async () => {
    await plantFake("ok");
    await write("a.ts", "const alpha = 1;\n");
    const res = await lspDefinitionTool.execute({ path: "a.ts", symbol: "nowhere" }, ctx());
    expect(res.isError).toBe(true);
    expect(res.output).toContain("does not appear");
  });

  it("reports diagnostics with severity and code", async () => {
    await plantFake("ok");
    await write("a.ts", "const alpha = 1;\nbeta\n");
    const res = await lspDiagnosticsTool.execute({ path: "a.ts" }, ctx());
    expect(res.output).toContain("a.ts:1:7  error [2304]");
    expect(res.output).toContain("warning");
    expect(res.isError).toBe(true);
  });

  it("does not call broken code clean when the server publishes an EMPTY set first", async () => {
    // What typescript-language-server actually does: an empty set the moment the
    // document opens, before the project is loaded, then the errors once it is.
    // Answering on the first push reported "no diagnostics at or above warning"
    // for a file whose only line is a type error — a clean bill of health for
    // broken code, which is the one wrong answer this tool must never give.
    //
    // It reached us as a CI flake (a loaded runner widens the gap), but the race
    // was there on every machine; the fast ones just usually won it.
    await plantFake("slowdiag");
    await write("a.ts", "const alpha = 1;\nbeta\n");
    const res = await lspDiagnosticsTool.execute({ path: "a.ts" }, ctx());
    expect(res.output).toContain("a.ts:1:7  error [2304]");
    expect(res.output).not.toContain("no diagnostics");
    expect(res.isError).toBe(true);
  });

  it("filters to errors when asked", async () => {
    await plantFake("ok");
    await write("a.ts", "const alpha = 1;\nbeta\n");
    const res = await lspDiagnosticsTool.execute({ path: "a.ts", severity: "error" }, ctx());
    expect(res.output).toContain("2304");
    expect(res.output).not.toContain("never read");
  });

  it("NEVER reports silence as a clean bill of health", async () => {
    // A server that is still indexing publishes nothing. Reporting that as
    // "no problems" is the one answer that would make this tool worse than
    // having none.
    await plantFake("nodiag");
    await write("a.ts", "const alpha = 1;\n");
    const res = await lspDiagnosticsTool.execute({ path: "a.ts" }, ctx());
    expect(res.output).toContain("NOT a clean bill of health");
  });

  it("renames every reference and reports the files", async () => {
    await plantFake("ok");
    await write("a.ts", "const alpha = 1;\nalpha + 2;\n");
    const res = await lspRenameTool.execute(
      { path: "a.ts", symbol: "alpha", new_name: "renamed" },
      ctx(),
    );
    expect(res.isError).toBeFalsy();
    expect(await fs.readFile(join(dir, "a.ts"), "utf8")).toBe("const renamed = 1;\nrenamed + 2;\n");
    // The rule mutatingDiff.test.ts states for every writing tool. It is
    // asserted here because that file has no business spawning a server, and
    // `lsp_rename` is the writing tool with the least reviewable change: the
    // server chose the edits, not the model.
    expect(res.path).toBe("a.ts");
    expect(res.diff?.some((r) => r.kind === "add" && r.text.includes("renamed"))).toBe(true);
  });

  it("dry_run writes nothing", async () => {
    await plantFake("ok");
    await write("a.ts", "const alpha = 1;\nalpha + 2;\n");
    const res = await lspRenameTool.execute(
      { path: "a.ts", symbol: "alpha", new_name: "renamed", dry_run: true },
      ctx(),
    );
    expect(res.output).toContain("Would rename");
    expect(await fs.readFile(join(dir, "a.ts"), "utf8")).toContain("alpha");
  });

  it("refuses an edit the SERVER pointed outside the working directory", async () => {
    // A workspace edit is a list of URIs the server chose, and a server pointed
    // at a monorepo root can legitimately name a file outside the directory the
    // agent was given.
    await plantFake("escape");
    await write("a.ts", "const alpha = 1;\n");
    const res = await lspRenameTool.execute(
      { path: "a.ts", symbol: "alpha", new_name: "renamed" },
      ctx(),
    );
    expect(res.isError).toBe(true);
    expect(res.output).toContain("outside the working directory");
    expect(await fs.readFile(join(dir, "a.ts"), "utf8")).toContain("alpha");
  });

  it("lists completions with their detail", async () => {
    await plantFake("ok");
    await write("a.ts", "const alpha = 1;\n");
    const res = await lspCompletionTool.execute({ path: "a.ts", line: 1, column: 1 }, ctx());
    expect(res.output).toContain("alpha");
    expect(res.output).toContain("(property) beta: string");
  });

  it("refuses a path outside the working directory", async () => {
    await plantFake("ok");
    await expect(
      lspDefinitionTool.execute({ path: "../../etc/hosts", symbol: "x" }, ctx()),
    ).rejects.toThrow(/escapes/);
  });

  it("covers only languages a server exists for", async () => {
    await write("a.rb", "def x; end\n");
    const res = await lspDefinitionTool.execute({ path: "a.rb", symbol: "x" }, ctx());
    expect(res.isError).toBe(true);
    expect(res.output).toContain("No language server covers");
  });
});

describe("uriOf", () => {
  it("produces a file URL the server will accept", () => {
    // The subject is the ESCAPING — a raw space is what a server rejects. The
    // input has to be an absolute path the platform recognises: `pathToFileURL`
    // resolves a bare "/tmp/…" against the current drive on Windows, so the old
    // literal asserted the drive letter (`file:///D:/tmp/a%20b.ts`) rather than
    // the encoding it was written for.
    const p = resolve(tmpdir(), "a b.ts");
    const uri = uriOf(p);
    expect(uri.startsWith("file:///")).toBe(true);
    expect(uri).toContain("a%20b.ts");
    expect(uri).not.toContain("a b.ts");
  });
});

describe("uriKey", () => {
  // The platform is a parameter so this is testable off Windows; the bug it
  // covers is only reachable there, and a fix nothing can exercise is a guess.
  it("folds case on Windows, where the server renames our drive letter", () => {
    // What actually happened: we opened `file:///C:/…`, tsserver published
    // `file:///c:/…`, the exact-string lookup missed, and `lsp_diagnostics`
    // answered "no diagnostics published" for a file with a type error in it.
    expect(uriKey("file:///C:/Users/x/a.ts", "win32")).toBe(
      uriKey("file:///c:/Users/x/a.ts", "win32"),
    );
  });

  it("also reconciles the escaped drive colon vscode-uri writes", () => {
    // `pathToFileURL` leaves the colon literal; typescript-language-server
    // serializes with vscode-uri, which escapes it. Two spellings, one file.
    expect(uriKey("file:///C:/Users/x/a.ts", "win32")).toBe(
      uriKey("file:///c%3A/Users/x/a.ts", "win32"),
    );
  });

  it("leaves a POSIX uri alone, where two cases are two files", () => {
    expect(uriKey("file:///tmp/A.ts", "linux")).toBe("file:///tmp/A.ts");
    expect(uriKey("file:///tmp/A.ts", "linux")).not.toBe(uriKey("file:///tmp/a.ts", "linux"));
  });
});

/**
 * Against a REAL typescript-language-server.
 *
 * The fake proves the client survives a server behaving badly; only the real
 * one proves the protocol is right — the same reason `unifiedDiff`'s tests hand
 * their output to `git apply` rather than asserting on our own string. Skipped
 * when the server is absent: it is a dev dependency here and optional everywhere.
 */
const realServer = await resolveServerBinary("typescript-language-server", process.cwd());

describe.runIf(realServer)("against a real typescript-language-server", () => {
  /**
   * A temp project. Deliberately WITHOUT a local `node_modules/.bin` copy: a
   * pnpm shim resolves its module relative to its own directory, so a symlink
   * to one from elsewhere finds nothing. The PATH branch of `resolveServerBinary`
   * picks up the workspace's working shim, which is the branch a user's global
   * install takes anyway.
   */
  const project = async () => {
    await fs.writeFile(
      join(dir, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { strict: true, noEmit: true } }),
    );
  };

  const patient = async <T>(run: () => Promise<T>): Promise<T> => {
    // A bound, not a sleep: a published notification resolves the wait at once,
    // so a generous ceiling costs nothing when the server is healthy and only
    // buys room on a slow runner. The Windows CI leg loads the project from a
    // cold disk, and the test itself is allowed 90s.
    process.env.ARTERM_LSP_DIAGNOSTICS_MS = "60000";
    process.env.ARTERM_LSP_REQUEST_MS = "60000";
    try {
      return await run();
    } finally {
      process.env.ARTERM_LSP_DIAGNOSTICS_MS = "500";
      process.env.ARTERM_LSP_REQUEST_MS = "800";
    }
  };

  it("reports the compiler's own diagnostic for a real type error", async () => {
    await patient(async () => {
      await project();
      await fs.writeFile(join(dir, "a.ts"), 'const n: number = "not a number";\n');
      const res = await lspDiagnosticsTool.execute({ path: "a.ts" }, ctx());
      // The message is TypeScript's, not ours — that is the whole point.
      expect(res.output).toMatch(/2322|not assignable/i);
      expect(res.output).toContain("a.ts:1:7");
    });
  }, 90_000);

  it("renames the binding, not the text", async () => {
    // What `replace` gets wrong: the same word in a comment and in a string is
    // not the symbol, and the compiler knows which occurrences are.
    await patient(async () => {
      await project();
      await fs.writeFile(
        join(dir, "a.ts"),
        [
          "export function alpha(): number {",
          "  return 1;",
          "}",
          "// alpha in a comment",
          'const s = "alpha in a string";',
          "export const used = alpha();",
        ].join("\n"),
      );
      const res = await lspRenameTool.execute(
        { path: "a.ts", symbol: "alpha", new_name: "renamed" },
        ctx(),
      );
      expect(res.isError).toBeFalsy();
      const after = await fs.readFile(join(dir, "a.ts"), "utf8");
      expect(after).toContain("export function renamed()");
      expect(after).toContain("export const used = renamed();");
      expect(after).toContain("// alpha in a comment");
      expect(after).toContain('"alpha in a string"');
    });
  }, 90_000);
});
