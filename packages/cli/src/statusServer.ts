import { randomBytes, randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import { join } from "node:path";
import { ARTERM_HOME } from "@arterm/core";
import type { Session } from "@arterm/tui";
import { StatusState, control } from "./statusState.js";

/**
 * Loopback-only HTTP + SSE status server for the Arterm desktop app.
 * Protocol contract: docs/desktop-integration.md (v1). Serves a live snapshot,
 * a stamped event stream, and a control endpoint; announces itself via a
 * discovery file at `$ARTERM_HOME/status/<pid>-<sessionId>.json` (which is
 * `~/.arterm/status` unless redirected). One process may host several sessions,
 * each with its own server and discovery file.
 *
 * The directory comes from `ARTERM_HOME`, not from `homedir()`, and that is the
 * difference between a test and a mess: `statusServer.test.ts` CREATES discovery
 * files and asserts they exist, so with the path computed here the suite wrote
 * into the developer's own `~/.arterm/status` on every run. It cleaned up after
 * itself, which is exactly why nobody noticed — the same shape as the
 * `config.json` overwrite that `configIsolation.test.ts` was written for, and
 * which that guard did not cover because it only knew about one file.
 *
 * It also decides whether a confined run can test itself at all: `~/.arterm` is
 * not one of the sandbox's write roots, so under `--autonomous` this path failed
 * every status test until it followed the redirect.
 */

export const STATUS_DIR = join(ARTERM_HOME, "status");
const MAX_CONTROL_BODY = 64 * 1024;

/** A running status server. */
export interface StatusServer {
  url: string;
  port: number;
  token: string;
  close: () => Promise<void>;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(payload);
}

/** DNS-rebinding guard: only plain loopback hosts may address this server. */
function hostAllowed(req: IncomingMessage): boolean {
  const host = req.headers.host ?? "";
  return /^(127\.0\.0\.1|localhost)(:\d+)?$/i.test(host);
}

function tokenOf(req: IncomingMessage, url: URL): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) return header.slice("Bearer ".length).trim();
  return url.searchParams.get("token");
}

/** Delete discovery files whose pid is no longer alive. */
function sweepStaleDiscovery(): void {
  let names: string[];
  try {
    names = readdirSync(STATUS_DIR);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const file = join(STATUS_DIR, name);
    let pid = Number.parseInt(name, 10);
    if (!Number.isFinite(pid) || pid <= 0) {
      try {
        pid = Number(JSON.parse(readFileSync(file, "utf8")).pid);
      } catch {
        pid = Number.NaN;
      }
    }
    if (!Number.isFinite(pid) || pid <= 0) continue;
    try {
      process.kill(pid, 0); // alive (or EPERM — leave it)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ESRCH") {
        try {
          unlinkSync(file);
        } catch {
          // best-effort
        }
      }
    }
  }
}

// One exit handler unlinks every live discovery file, however many sessions
// this process hosts — per-server process.on("exit") would trip the listener
// warning past ten sessions.
const liveDiscoveryFiles = new Set<string>();
let exitUnlinkInstalled = false;

/** Signals whose default action kills us WITHOUT running the "exit" handler. */
const SHUTDOWN_SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"] as const;

function unlinkDiscoveryFiles(): void {
  for (const f of liveDiscoveryFiles) {
    try {
      unlinkSync(f);
    } catch {
      // best-effort
    }
  }
  liveDiscoveryFiles.clear();
}

function trackDiscoveryFile(file: string): void {
  liveDiscoveryFiles.add(file);
  if (exitUnlinkInstalled) return;
  exitUnlinkInstalled = true;
  process.on("exit", unlinkDiscoveryFiles);
  // A `kill`, a `timeout`, or a service manager stopping us terminates the
  // process without ever running the "exit" handler above, which would strand
  // this session in the desktop's Agents list until the next sweep. So unlink on
  // the way out, then let the signal do its job.
  for (const signal of SHUTDOWN_SIGNALS) {
    const handler = (): void => {
      unlinkDiscoveryFiles();
      // Registering a listener suppressed the default termination. If ours is the
      // only one, restore it: drop the listener and re-raise, so the parent still
      // sees "killed by <signal>" instead of a fabricated exit code. When
      // something else listens too (an `arterm memory serve` owns SIGINT, Ink
      // unmounts the TUI), the shutdown is theirs to finish — cleanup was the
      // whole of our business here.
      if (process.listenerCount(signal) === 1) {
        process.removeListener(signal, handler);
        process.kill(process.pid, signal);
      }
    };
    process.on(signal, handler);
  }
}

/**
 * Resolves whether a session publishes itself to the desktop (contract §1).
 *
 * `"auto"` (the default) means **every interactive session**, in ANY terminal —
 * a CLI started in Konsole/Alacritty belongs in the desktop's Agents list just as
 * much as one started in Arterm's own terminal. What "auto" still withholds is
 * the headless one-shot (`-p`), which lives for seconds and mostly runs from
 * scripts and CI: there a bound port and a discovery file are noise, so it
 * publishes only inside the Arterm terminal (`ARTERM_TERMINAL`), where the
 * desktop actually has a tab to attach it to.
 *
 * `true` publishes unconditionally (headless included), `false` never, and a
 * pinned `--status-port` implies on. Kept pure and separate from the wiring so
 * the policy is testable without binding a socket.
 */
export function shouldPublish(opts: {
  enabled: boolean | "auto";
  /** True for the TUI; false for a headless one-shot run. */
  interactive: boolean;
  /** A `--status-port` was given, which implies the server is wanted. */
  pinnedPort?: boolean;
  /** Set by the Arterm desktop's own terminal (defaults to the live env). */
  artermTerminal?: boolean;
}): boolean {
  if (opts.pinnedPort) return true;
  if (opts.enabled !== "auto") return opts.enabled;
  if (opts.interactive) return true;
  return opts.artermTerminal ?? Boolean(process.env.ARTERM_TERMINAL);
}

/** Atomically write one session's discovery file (contract §1). */
function writeDiscovery(entry: {
  port: number;
  token: string;
  sessionId: string;
  cwd: string;
  model: string;
  provider: string;
  startedAt: number;
}): string {
  mkdirSync(STATUS_DIR, { recursive: true });
  const name = `${process.pid}-${entry.sessionId}.json`;
  const file = join(STATUS_DIR, name);
  const tmp = join(STATUS_DIR, `${name}.tmp`);
  const terminalId = Number(process.env.ARTERM_TERMINAL_ID);
  const body = {
    v: 1,
    pid: process.pid,
    sessionId: entry.sessionId,
    port: entry.port,
    token: entry.token,
    cwd: entry.cwd,
    model: entry.model,
    provider: entry.provider,
    startedAt: entry.startedAt,
    ...(Number.isFinite(terminalId) && terminalId > 0 ? { terminalId } : {}),
  };
  writeFileSync(tmp, JSON.stringify(body, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
  return file;
}

/**
 * Start the status server for a session. Binds 127.0.0.1 on the given port
 * (0 = OS-assigned). Every route except /api/health requires the bearer token.
 */
export function startStatusServer(opts: {
  session: Session;
  cwd: string;
  port?: number;
  sessionId?: string;
}): Promise<StatusServer> {
  const token = randomBytes(16).toString("hex");
  const sessionId = opts.sessionId ?? randomUUID();
  const startedAt = Date.now();
  const state = new StatusState(opts.session, { sessionId, cwd: opts.cwd });

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    if (!hostAllowed(req)) {
      json(res, 403, { error: "forbidden host" });
      return;
    }

    if (path === "/api/health") {
      if (req.method !== "GET") {
        json(res, 405, { error: "method not allowed" });
        return;
      }
      json(res, 200, { v: 1, ok: true, pid: process.pid, sessionId });
      return;
    }

    if (tokenOf(req, url) !== token) {
      json(res, 401, { error: "unauthorized" });
      return;
    }

    if (path === "/api/state") {
      if (req.method !== "GET") {
        json(res, 405, { error: "method not allowed" });
        return;
      }
      json(res, 200, { v: 1, state: state.snapshot() });
      return;
    }

    if (path === "/api/stream") {
      if (req.method !== "GET") {
        json(res, 405, { error: "method not allowed" });
        return;
      }
      streamStatus(req, res, url);
      return;
    }

    if (path === "/api/control") {
      if (req.method !== "POST") {
        json(res, 405, { error: "method not allowed" });
        return;
      }
      await handleControl(req, res);
      return;
    }

    json(res, 404, { error: "not found" });
  };

  /** SSE per contract §3: snapshot frame, then live `agent`/`state` frames. */
  const streamStatus = (req: IncomingMessage, res: ServerResponse, url: URL): void => {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
    });

    const sinceRaw = Number(url.searchParams.get("since"));
    const since = Number.isFinite(sinceRaw) && sinceRaw > 0 ? sinceRaw : undefined;
    res.write(
      `event: snapshot\ndata: ${JSON.stringify({
        v: 1,
        state: state.snapshot(),
        events: state.events(since),
      })}\n\n`,
    );

    const unsubscribe = state.addSubscriber((msg) => {
      if (msg.kind === "event") {
        res.write(`event: agent\nid: ${msg.event.seq}\ndata: ${JSON.stringify(msg.event)}\n\n`);
      } else {
        res.write(`event: state\ndata: ${JSON.stringify(msg.state)}\n\n`);
      }
    });

    const keepAlive = setInterval(() => {
      res.write(": ping\n\n");
    }, 25_000);

    req.on("close", () => {
      clearInterval(keepAlive);
      unsubscribe();
      res.end();
    });
  };

  const handleControl = (req: IncomingMessage, res: ServerResponse): Promise<void> =>
    new Promise((resolve) => {
      let body = "";
      let overflow = false;
      req.on("data", (chunk: Buffer) => {
        if (overflow) return;
        body += chunk.toString("utf8");
        if (body.length > MAX_CONTROL_BODY) {
          overflow = true;
          json(res, 400, { error: "body too large" });
          req.destroy();
          resolve();
        }
      });
      req.on("end", async () => {
        if (overflow) return;
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(body || "{}") as Record<string, unknown>;
        } catch {
          json(res, 400, { error: "malformed JSON body" });
          resolve();
          return;
        }
        const str = (key: string): string | undefined =>
          typeof parsed[key] === "string" ? (parsed[key] as string) : undefined;
        // Awaited: `rewind` restores files and is the one action that cannot
        // answer synchronously. The snapshot is taken AFTER, so the response
        // already reflects what the action did.
        const result = await control(opts.session, {
          action: str("action") ?? "",
          note: str("note"),
          mode: str("mode"),
          id: str("id"),
          answer: str("answer"),
          checkpointId: str("checkpointId"),
        });
        json(res, 200, { ...result, state: state.snapshot() });
        resolve();
      });
    });

  const server = createServer((req, res) => {
    handler(req, res).catch(() => json(res, 500, { error: "internal error" }));
  });

  return new Promise((resolve, reject) => {
    server.once("error", (err) => {
      state.dispose();
      reject(err);
    });
    server.listen(opts.port ?? 0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : (opts.port ?? 0);

      sweepStaleDiscovery();
      let discoveryFile: string | undefined;
      try {
        discoveryFile = writeDiscovery({
          port,
          token,
          sessionId,
          cwd: opts.cwd,
          model: opts.session.agent.model,
          provider: opts.session.providerLabel,
          startedAt,
        });
      } catch {
        // Discovery is best-effort; the server still works if the file can't be written.
      }

      if (discoveryFile) trackDiscoveryFile(discoveryFile);

      const unlinkDiscovery = (): void => {
        if (!discoveryFile) return;
        liveDiscoveryFiles.delete(discoveryFile);
        try {
          unlinkSync(discoveryFile);
        } catch {
          // best-effort
        }
        discoveryFile = undefined;
      };

      resolve({
        url: `http://127.0.0.1:${port}`,
        port,
        token,
        close: () =>
          new Promise<void>((done) => {
            unlinkDiscovery();
            state.dispose();
            server.close(() => done());
            // SSE responses hold connections open; drop them so close() completes.
            server.closeAllConnections();
          }),
      });
    });
  });
}
