/**
 * One language server, kept alive.
 *
 * Starting `typescript-language-server` on a real repository costs seconds
 * before it can answer anything — it loads the program. A tool that started one
 * per call would make every question cost that, which is the opposite of the
 * reason to have a language server at all. So a client is cached per (root,
 * language) for the process and disposed at session teardown.
 *
 * The environment is scrubbed, for the reason `credentials.ts` gives: this is a
 * spawned process that has no use for the session's API keys, and a language
 * server runs plugins and reads project config. It does NOT go through the
 * sandbox: that wrapper is built for one-shot commands (`wrap` then `release`
 * per command) and a long-lived process does not fit it. The specific egress a
 * TypeScript server would otherwise open — automatic type acquisition, which
 * fetches @types packages from the registry — is turned off in the
 * initialization options instead of being left to a boundary that is not there.
 */

import type { ChildProcess } from "node:child_process";
import { pathToFileURL } from "node:url";
import { type CredentialSettings, scrubEnv } from "@arterm/core";
import type { CallLang } from "../treeSitter.js";
import { RpcConnection } from "./protocol.js";
import { type ResolvedServer, languageIdFor } from "./servers.js";

/**
 * How long a server gets, per stage.
 *
 * Environment-overridable because the right value is a property of the machine
 * and the repository, not of this code: `typescript-language-server` on a large
 * monorepo can spend a minute loading the program before it answers anything,
 * and a fixed 30s there turns a working setup into a tool that always times
 * out. Read per call so a session can be tuned without a restart.
 */
function timeout(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}
const initTimeout = () => timeout("ARTERM_LSP_INIT_MS", 30_000);
const requestTimeout = () => timeout("ARTERM_LSP_REQUEST_MS", 15_000);
const diagnosticWait = () => timeout("ARTERM_LSP_DIAGNOSTICS_MS", 8_000);

export interface LspPosition {
  line: number;
  character: number;
}
export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}
export interface LspLocation {
  uri: string;
  range: LspRange;
}
export interface LspDiagnostic {
  range: LspRange;
  severity?: number;
  code?: string | number;
  source?: string;
  message: string;
}
export interface TextEdit {
  range: LspRange;
  newText: string;
}
export interface WorkspaceEdit {
  changes?: Record<string, TextEdit[]>;
  documentChanges?: Array<{ textDocument: { uri: string }; edits: TextEdit[] }>;
}

export function uriOf(path: string): string {
  return pathToFileURL(path).toString();
}

/**
 * The key a URI is filed under, as opposed to the URI we send.
 *
 * `publishDiagnostics` is a PUSH: the server names the document, and it names it
 * its own way. TypeScript's server lower-cases a Windows drive letter, so the
 * `file:///C:/…` we sent came back as `file:///c:/…` and an exact-string lookup
 * never found it — `lsp_diagnostics` reported "the language server published no
 * diagnostics" for every file on Windows, which reads as a clean bill of health
 * for a file with a type error in it.
 *
 * Windows paths are case-insensitive, so folding the whole URI is safe there and
 * catches the same disagreement about any other segment. On POSIX the case is
 * meaningful and the URI is left exactly as it is.
 */
export function uriKey(uri: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? uri.toLowerCase() : uri;
}

export class LspClient {
  private diagnostics = new Map<string, LspDiagnostic[]>();
  private diagnosticWaiters = new Map<string, Array<() => void>>();
  private opened = new Set<string>();
  private disposed = false;

  private constructor(
    private child: ChildProcess,
    private rpc: RpcConnection,
    readonly server: ResolvedServer,
  ) {}

  /** Start and initialize a server, or throw with a reason a reader can act on. */
  static async start(
    server: ResolvedServer,
    root: string,
    opts: { credentials?: CredentialSettings } = {},
  ): Promise<LspClient> {
    const { execa } = await import("execa");
    const { env } = scrubEnv({ ...process.env }, opts.credentials);
    const child = execa(server.binary, server.spec.args, {
      cwd: root,
      env,
      extendEnv: false,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      reject: false,
      buffer: false,
    });
    if (!child.stdin || !child.stdout) {
      throw new Error(`${server.spec.command} did not open a stdio pipe`);
    }
    const rpc = new RpcConnection(child.stdin, child.stdout);
    const client = new LspClient(child, rpc, server);

    // A server that refuses to start says why on stderr — a missing peer
    // dependency, an unreadable tsconfig. Piped and then never read, that
    // explanation is thrown away and every failure reads as the same opaque
    // "closed its output".
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-2_000);
    });
    child.on("exit", (code) => {
      const why = stderr.trim();
      rpc.fail(
        new Error(
          `${server.spec.command} exited with code ${code ?? "unknown"}${why ? `: ${why}` : ""}`,
        ),
      );
    });
    rpc.onNotification((method, params) => {
      if (method !== "textDocument/publishDiagnostics") return;
      const p = params as { uri: string; diagnostics: LspDiagnostic[] };
      const key = uriKey(p.uri);
      client.diagnostics.set(key, p.diagnostics ?? []);
      const waiting = client.diagnosticWaiters.get(key);
      if (waiting) {
        client.diagnosticWaiters.delete(key);
        for (const wake of waiting) wake();
      }
    });

    await rpc.request(
      "initialize",
      {
        processId: process.pid,
        rootUri: uriOf(root),
        workspaceFolders: [{ uri: uriOf(root), name: "root" }],
        capabilities: {
          textDocument: {
            synchronization: { didSave: false, dynamicRegistration: false },
            publishDiagnostics: {},
            definition: { linkSupport: false },
            rename: { prepareSupport: false },
            completion: { completionItem: { snippetSupport: false } },
          },
          workspace: { workspaceEdit: { documentChanges: true }, workspaceFolders: true },
        },
        initializationOptions: {
          // The one egress path a TS server opens on its own. Off, because the
          // sandbox is not in front of this process to close it.
          disableAutomaticTypingAcquisition: true,
        },
      },
      initTimeout(),
    );
    rpc.notify("initialized", {});
    return client;
  }

  /**
   * Tell the server about a file's CURRENT content.
   *
   * Sent from what is on disk, and re-sent on every call rather than tracked
   * incrementally: the agent edits files with its own tools, behind the
   * server's back, and a server answering from a stale copy gives positions
   * that point at the wrong lines — which is worse than no answer.
   */
  async didOpen(path: string, text: string, lang: CallLang): Promise<string> {
    const uri = uriOf(path);
    const key = uriKey(uri);
    if (this.opened.has(key)) {
      this.rpc.notify("textDocument/didClose", { textDocument: { uri } });
      this.opened.delete(key);
    }
    this.diagnostics.delete(key);
    this.rpc.notify("textDocument/didOpen", {
      textDocument: { uri, languageId: languageIdFor(lang), version: 1, text },
    });
    this.opened.add(key);
    return uri;
  }

  /**
   * Diagnostics for an open file.
   *
   * Base LSP PUSHES these; there is no request to ask for them, so this waits
   * for the notification with a bound. A server that publishes nothing within
   * the bound means "no diagnostics yet", not "no problems" — the caller says
   * which it got.
   */
  async waitForDiagnostics(uri: string): Promise<{ items: LspDiagnostic[]; arrived: boolean }> {
    const key = uriKey(uri);
    const existing = this.diagnostics.get(key);
    if (existing) return { items: existing, arrived: true };
    let timer: NodeJS.Timeout | undefined;
    await new Promise<void>((resolve) => {
      const waiters = this.diagnosticWaiters.get(key) ?? [];
      waiters.push(resolve);
      this.diagnosticWaiters.set(key, waiters);
      timer = setTimeout(resolve, diagnosticWait());
      timer.unref?.();
    });
    if (timer) clearTimeout(timer);
    const items = this.diagnostics.get(key);
    return { items: items ?? [], arrived: items !== undefined };
  }

  definition(uri: string, position: LspPosition): Promise<unknown> {
    return this.rpc.request(
      "textDocument/definition",
      { textDocument: { uri }, position },
      requestTimeout(),
    );
  }

  rename(uri: string, position: LspPosition, newName: string): Promise<unknown> {
    return this.rpc.request(
      "textDocument/rename",
      { textDocument: { uri }, position, newName },
      requestTimeout(),
    );
  }

  completion(uri: string, position: LspPosition): Promise<unknown> {
    return this.rpc.request(
      "textDocument/completion",
      { textDocument: { uri }, position },
      requestTimeout(),
    );
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    try {
      // Best effort: a server that will not shut down politely gets killed.
      await Promise.race([
        this.rpc.request("shutdown", null, 2_000),
        new Promise((r) => setTimeout(r, 2_000)),
      ]);
      this.rpc.notify("exit", null);
    } catch {
      // Already gone.
    }
    this.rpc.dispose();
    this.child.kill("SIGTERM");
  }
}
