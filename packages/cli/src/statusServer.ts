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
import { homedir } from "node:os";
import { join } from "node:path";
import type { Session } from "@arterm/tui";
import { StatusState, control } from "./statusState.js";

/**
 * Loopback-only HTTP + SSE status server for the Arterm desktop app.
 * Protocol contract: docs/desktop-integration.md (v1). Serves a live snapshot,
 * a stamped event stream, and a control endpoint; announces itself via a
 * discovery file at `~/.arterm/status/<pid>.json`.
 */

export const STATUS_DIR = join(homedir(), ".arterm", "status");
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

/** Atomically write this process's discovery file (contract §1). */
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
  const file = join(STATUS_DIR, `${process.pid}.json`);
  const tmp = join(STATUS_DIR, `${process.pid}.json.tmp`);
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
      req.on("end", () => {
        if (overflow) return;
        let parsed: { action?: unknown; note?: unknown; mode?: unknown };
        try {
          parsed = JSON.parse(body || "{}");
        } catch {
          json(res, 400, { error: "malformed JSON body" });
          resolve();
          return;
        }
        const action = typeof parsed.action === "string" ? parsed.action : "";
        const note = typeof parsed.note === "string" ? parsed.note : "";
        const mode = typeof parsed.mode === "string" ? parsed.mode : undefined;
        const result = control(opts.session, action, note, mode);
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

      const unlinkDiscovery = (): void => {
        if (!discoveryFile) return;
        try {
          unlinkSync(discoveryFile);
        } catch {
          // best-effort
        }
        discoveryFile = undefined;
      };
      process.on("exit", unlinkDiscovery);

      resolve({
        url: `http://127.0.0.1:${port}`,
        port,
        token,
        close: () =>
          new Promise<void>((done) => {
            unlinkDiscovery();
            process.removeListener("exit", unlinkDiscovery);
            state.dispose();
            server.close(() => done());
            // SSE responses hold connections open; drop them so close() completes.
            server.closeAllConnections();
          }),
      });
    });
  });
}
