import { readFile } from "node:fs/promises";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { type WebSocket, WebSocketServer } from "ws";
import type { AgentMeta, AgentMsg, ToUiMsg, UiMsg } from "./hqProtocol.js";
import { HQ_AGGREGATOR_PORT } from "./hqProtocol.js";
import { RING_MAX, type StampedEvent } from "./hqState.js";

/**
 * Multi-agent **HQ aggregator** — a long-lived hub that many `arterm` processes report
 * to (WS `/agent`) and that web clients monitor + control (WS `/ui`). Holds an in-memory
 * registry of agents with their last state + a bounded event ring, and routes control
 * commands from the UI back to the right agent process.
 *
 * Also serves the built web app (static `webDir`) at `/`, so in production the whole
 * dashboard is one `arterm hq` command. SECURITY: binds `127.0.0.1` only, no auth —
 * it exposes control across every connected agent; never bind a public interface.
 */

export interface HqAggregator {
  url: string;
  close: () => Promise<void>;
}

interface AgentEntry {
  meta: AgentMeta;
  socket: WebSocket;
  lastState?: Record<string, unknown>;
  ring: StampedEvent[];
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".png": "image/png",
};

export function startHqAggregator(opts: { port?: number; webDir?: string }): Promise<HqAggregator> {
  const agents = new Map<string, AgentEntry>();
  const uiClients = new Set<WebSocket>();

  const agentList = (): AgentMeta[] => [...agents.values()].map((a) => a.meta);
  const sendUi = (ws: WebSocket, msg: ToUiMsg): void => ws.send(JSON.stringify(msg));
  const broadcastUi = (msg: ToUiMsg): void => {
    const raw = JSON.stringify(msg);
    for (const ws of uiClients) ws.send(raw);
  };
  const pushAgents = (): void => broadcastUi({ t: "agents", agents: agentList() });

  // --- HTTP: JSON agent list + static web app (built Next.js export) -------------
  const serveStatic = async (res: ServerResponse, path: string): Promise<void> => {
    if (!opts.webDir) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(PLACEHOLDER_HTML);
      return;
    }
    // Confine to webDir; map "/" and extensionless routes to their .html.
    const rel = path === "/" ? "index.html" : path.replace(/^\/+/, "");
    const candidate = normalize(join(opts.webDir, rel));
    const file = candidate.startsWith(normalize(opts.webDir))
      ? extname(candidate)
        ? candidate
        : `${candidate}.html`
      : opts.webDir;
    try {
      const body = await readFile(file);
      res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      // SPA fallback: unknown route → index.html (client router handles it).
      try {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(await readFile(join(opts.webDir, "index.html")));
      } catch {
        res.writeHead(404).end("not found");
      }
    }
  };

  const httpHandler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/api/agents") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ agents: agentList() }));
      return;
    }
    await serveStatic(res, url.pathname);
  };

  const server = createServer((req, res) => {
    httpHandler(req, res).catch(() => res.writeHead(500).end("internal error"));
  });

  // --- WebSocket: /agent (producers) and /ui (consumers) -------------------------
  const agentWss = new WebSocketServer({ noServer: true });
  const uiWss = new WebSocketServer({ noServer: true });

  agentWss.on("connection", (ws) => {
    let id: string | undefined;
    ws.on("message", (raw) => {
      let msg: AgentMsg;
      try {
        msg = JSON.parse(String(raw)) as AgentMsg;
      } catch {
        return;
      }
      if (msg.t === "register") {
        id = msg.meta.id;
        agents.set(id, { meta: { ...msg.meta, online: true }, socket: ws, ring: [] });
        pushAgents();
      } else if (id) {
        const entry = agents.get(id);
        if (!entry) return;
        if (msg.t === "snapshot") {
          entry.lastState = msg.state;
          entry.ring = msg.events.slice(-RING_MAX);
          broadcastUi({ t: "state", agentId: id, state: msg.state });
        } else if (msg.t === "event") {
          entry.ring.push(msg.event);
          if (entry.ring.length > RING_MAX) entry.ring.shift();
          broadcastUi({ t: "event", agentId: id, event: msg.event });
        } else if (msg.t === "state") {
          entry.lastState = msg.state;
          broadcastUi({ t: "state", agentId: id, state: msg.state });
        }
      }
    });
    ws.on("close", () => {
      if (id && agents.has(id)) {
        const entry = agents.get(id);
        if (entry) entry.meta = { ...entry.meta, online: false };
        pushAgents();
      }
    });
  });

  uiWss.on("connection", (ws) => {
    uiClients.add(ws);
    sendUi(ws, { t: "agents", agents: agentList() });
    ws.on("message", (raw) => {
      let msg: UiMsg;
      try {
        msg = JSON.parse(String(raw)) as UiMsg;
      } catch {
        return;
      }
      if (msg.t === "subscribe") {
        const entry = agents.get(msg.agentId);
        if (entry?.lastState) {
          sendUi(ws, {
            t: "snapshot",
            agentId: msg.agentId,
            state: entry.lastState,
            events: entry.ring,
          });
        }
      } else if (msg.t === "control") {
        const entry = agents.get(msg.agentId);
        if (entry?.meta.online) {
          entry.socket.send(JSON.stringify({ t: "control", action: msg.action, note: msg.note }));
        }
      }
    });
    ws.on("close", () => uiClients.delete(ws));
  });

  server.on("upgrade", (req, socket, head) => {
    const { pathname } = new URL(req.url ?? "/", "http://localhost");
    if (pathname === "/agent") {
      agentWss.handleUpgrade(req, socket, head, (ws) => agentWss.emit("connection", ws, req));
    } else if (pathname === "/ui") {
      uiWss.handleUpgrade(req, socket, head, (ws) => uiWss.emit("connection", ws, req));
    } else {
      socket.destroy();
    }
  });

  const port = opts.port ?? HQ_AGGREGATOR_PORT;
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      const boundPort = typeof addr === "object" && addr ? addr.port : port;
      resolve({
        url: `http://127.0.0.1:${boundPort}`,
        close: () =>
          new Promise<void>((done) => {
            for (const ws of uiClients) ws.close();
            for (const a of agents.values()) a.socket.close();
            agentWss.close();
            uiWss.close();
            server.close(() => done());
          }),
      });
    });
  });
}

/** Shown until the web app is built (`web/` → static). */
const PLACEHOLDER_HTML = `<!doctype html><meta charset="utf-8"><title>Arterm · HQ</title>
<body style="font:14px ui-monospace,monospace;background:#0d1117;color:#e6edf3;padding:32px">
<h1 style="color:#58a6ff">Arterm · HQ aggregator</h1>
<p>The aggregator is running. The web app is not built yet — run <code>pnpm --filter @arterm/web build</code>,
or connect a UI client to <code>ws://127.0.0.1:7788/ui</code>.</p>
<p>Agents connect at <code>ws://127.0.0.1:7788/agent</code>. Live registry:
<a style="color:#58a6ff" href="/api/agents">/api/agents</a></p>
</body>`;
