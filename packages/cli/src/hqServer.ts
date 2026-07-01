import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import type { AgentEvent } from "@arterm/core";
import type { Session } from "@arterm/tui";
import { openBrowser } from "./browser.js";

/**
 * In-process **HQ dashboard** — a live web view of the running agent session.
 *
 * Subscribes ONCE to `session.bus` (the full typed event firehose) and derives a
 * live snapshot (status, tokens, active tool, autonomy state, fleet workers). Serves
 * it over loopback HTTP + Server-Sent Events, and accepts control POSTs that drive
 * `session.autonomy.*` exactly as the TUI slash commands do.
 *
 * SECURITY: binds `127.0.0.1` ONLY and has no auth. It exposes control (pause / stop /
 * steer / goal), so it must never be bound to a non-loopback interface. Same
 * single-user threat model as the memory viewer (`memoryServer.ts`).
 */

/** A running HQ dashboard server. */
export interface HqServer {
  url: string;
  close: () => Promise<void>;
}

/** An `AgentEvent` stamped with a monotonic seq + wall-clock time at the sink. */
type StampedEvent = { seq: number; ts: number } & AgentEvent;

const RING_MAX = 500;
const STATE_THROTTLE_MS = 250;

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

interface Worker {
  task: string;
  role?: string;
  state: "running" | "done";
  output?: string;
}

/**
 * The single in-process hub: one `bus.on` subscription feeding a bounded event ring
 * plus derived live fields, fanned out to any number of SSE clients. Mirrors the
 * event→state mapping the TUI does in `App.tsx`.
 */
class HqState {
  private seq = 0;
  private ring: StampedEvent[] = [];
  private inTok = 0;
  private outTok = 0;
  private ctxUsed = 0;
  private rounds = 0;
  private status: "idle" | "thinking" | "tool" = "idle";
  private activeTool: string | null = null;
  private workers: Worker[] = [];
  private fleet = { active: 0, round: 0 };
  private readonly subscribers = new Set<(chunk: string) => void>();
  private readonly unsubscribe: () => void;
  private stateTimer: NodeJS.Timeout | undefined;

  constructor(private readonly session: Session) {
    this.unsubscribe = session.bus.on((ev) => this.push(ev));
  }

  private push(ev: AgentEvent): void {
    switch (ev.type) {
      case "turn_start":
        this.status = "thinking";
        break;
      case "tool_call":
        this.status = "tool";
        this.activeTool = ev.call.name;
        break;
      case "tool_result":
      case "tool_denied":
        this.status = "thinking";
        this.activeTool = null;
        break;
      case "assistant_message":
        this.rounds += 1;
        break;
      case "usage":
        this.inTok += ev.usage.promptTokens ?? 0;
        this.outTok += ev.usage.completionTokens ?? 0;
        if (ev.usage.promptTokens) this.ctxUsed = ev.usage.promptTokens;
        break;
      case "context_compacted":
        this.ctxUsed = 0;
        break;
      case "turn_end":
        this.status = "idle";
        this.activeTool = null;
        break;
      case "subagent_start":
        this.workers.push({ task: ev.task, role: ev.role, state: "running" });
        break;
      case "subagent_done": {
        const w = [...this.workers].reverse().find((x) => x.state === "running");
        if (w) {
          w.state = "done";
          w.output = ev.output;
        }
        break;
      }
      case "fleet_start":
        this.fleet.active = ev.count;
        break;
      case "fleet_done":
        this.fleet.active = 0;
        break;
      case "autonomy_fleet_round":
        this.fleet.round = ev.round;
        break;
    }

    // `text_delta` is one event per streamed token — keep it OUT of the ring and off
    // the per-event SSE push to avoid flooding slow clients.
    if (ev.type !== "text_delta") {
      const stamped = { seq: ++this.seq, ts: Date.now(), ...ev } as StampedEvent;
      this.ring.push(stamped);
      if (this.ring.length > RING_MAX) this.ring.shift();
      this.fanout(JSON.stringify({ type: "event", event: stamped }));
    }
    this.scheduleState();
  }

  /** Coalesce derived-state pushes to ~4/sec regardless of event burst rate. */
  private scheduleState(): void {
    if (this.stateTimer) return;
    this.stateTimer = setTimeout(() => {
      this.stateTimer = undefined;
      this.fanout(JSON.stringify({ type: "state", state: this.snapshot() }));
    }, STATE_THROTTLE_MS);
  }

  private fanout(chunk: string): void {
    for (const send of this.subscribers) send(chunk);
  }

  snapshot(): Record<string, unknown> {
    return {
      status: this.status,
      model: this.session.agent.model,
      provider: this.session.providerLabel,
      permissionMode: this.session.permissionMode,
      toolCount: this.session.toolCount,
      tokens: { in: this.inTok, out: this.outTok, ctx: this.ctxUsed },
      activeTool: this.activeTool,
      rounds: this.rounds,
      autonomy: this.session.autonomy.snapshot(),
      fleet: this.fleet,
      workers: this.workers,
      seq: this.seq,
    };
  }

  addSubscriber(send: (chunk: string) => void): () => void {
    this.subscribers.add(send);
    return () => this.subscribers.delete(send);
  }

  /** Initial catch-up frame for a freshly connected browser. */
  bootstrap(): string {
    return JSON.stringify({ type: "snapshot", state: this.snapshot(), events: this.ring });
  }

  dispose(): void {
    this.unsubscribe();
    if (this.stateTimer) clearTimeout(this.stateTimer);
    this.subscribers.clear();
  }
}

/** SSE connection: stream the bootstrap frame, then live event/state chunks. */
function stream(req: IncomingMessage, res: ServerResponse, state: HqState): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive",
  });
  res.write(`data: ${state.bootstrap()}\n\n`);

  const unsubscribe = state.addSubscriber((chunk) => res.write(`data: ${chunk}\n\n`));
  const keepAlive = setInterval(() => res.write(": ping\n\n"), 25_000);

  req.on("close", () => {
    clearInterval(keepAlive);
    unsubscribe();
    res.end();
  });
}

/** Read a request body fully, parse as JSON (empty body → {}). */
async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  return JSON.parse(raw) as Record<string, unknown>;
}

/** Dispatch a control action to the autonomy engine (all methods are safe off-run). */
function control(session: Session, action: string, note: string): { ok: boolean; error?: string } {
  switch (action) {
    case "pause":
      session.autonomy.pause();
      return { ok: true };
    case "resume":
      session.autonomy.resume();
      return { ok: true };
    case "stop":
      session.autonomy.stop();
      return { ok: true };
    case "steer":
      if (!note) return { ok: false, error: "steer requires a note" };
      session.autonomy.steer(note);
      return { ok: true };
    case "goal":
      if (!note) return { ok: false, error: "goal requires text" };
      void session.autonomy.start(note); // self-guards re-entry
      return { ok: true };
    default:
      return { ok: false, error: `unknown action "${action}"` };
  }
}

export function startHqServer(opts: {
  session: Session;
  port?: number;
  open?: boolean;
}): Promise<HqServer> {
  const { session } = opts;
  const state = new HqState(session);

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    if (path === "/" && req.method === "GET") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(HQ_HTML);
      return;
    }
    if (path === "/api/state" && req.method === "GET") {
      json(res, 200, state.snapshot());
      return;
    }
    if (path === "/api/stream" && req.method === "GET") {
      stream(req, res, state);
      return;
    }
    if (path === "/api/control" && req.method === "POST") {
      const body = await readJson(req);
      const action = String(body.action ?? "");
      const note = typeof body.note === "string" ? body.note.trim() : "";
      const result = control(session, action, note);
      json(res, result.ok ? 200 : 400, { ...result, state: session.autonomy.snapshot() });
      return;
    }
    json(res, 404, { error: "not found" });
  };

  const server = createServer((req, res) => {
    handler(req, res).catch(() => json(res, 500, { error: "internal error" }));
  });

  const port = opts.port ?? 7777;
  return new Promise((resolve, reject) => {
    server.once("error", (err) => {
      state.dispose();
      reject(err);
    });
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      const boundPort = typeof addr === "object" && addr ? addr.port : port;
      const url = `http://127.0.0.1:${boundPort}`;
      if (opts.open) void openBrowser(url);
      resolve({
        url,
        close: () =>
          new Promise<void>((done) => {
            state.dispose();
            server.close(() => done());
          }),
      });
    });
  });
}

/** Self-contained dashboard page — no build step, no framework, no external assets. */
const HQ_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Arterm · HQ</title>
<style>
  :root {
    --bg: #0d1117; --panel: #161b22; --border: #30363d; --fg: #e6edf3;
    --muted: #8b949e; --accent: #58a6ff; --green: #3fb950; --red: #f85149;
    --yellow: #d29922; --purple: #bc8cff;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg);
    font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  header { position: sticky; top: 0; background: var(--panel);
    border-bottom: 1px solid var(--border); padding: 10px 16px;
    display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
  header .title { font-weight: 700; color: var(--accent); }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--muted);
    display: inline-block; }
  .dot.live { background: var(--green); }
  .badge { padding: 1px 8px; border: 1px solid var(--border); border-radius: 999px;
    color: var(--muted); }
  .pill { padding: 1px 8px; border-radius: 999px; background: #21262d; }
  .pill.tool { color: var(--yellow); } .pill.thinking { color: var(--accent); }
  .pill.idle { color: var(--muted); }
  main { display: grid; grid-template-columns: 320px 1fr; gap: 14px; padding: 14px; }
  .panel { background: var(--panel); border: 1px solid var(--border);
    border-radius: 8px; padding: 12px; margin-bottom: 14px; }
  .panel h2 { margin: 0 0 8px; font-size: 11px; text-transform: uppercase;
    letter-spacing: .06em; color: var(--muted); }
  .kv { display: flex; justify-content: space-between; gap: 8px; padding: 2px 0; }
  .kv .k { color: var(--muted); }
  .bar { height: 6px; background: #21262d; border-radius: 3px; overflow: hidden; margin: 6px 0; }
  .bar > i { display: block; height: 100%; background: var(--accent); }
  button { font: inherit; background: #21262d; color: var(--fg);
    border: 1px solid var(--border); border-radius: 6px; padding: 5px 10px; cursor: pointer; }
  button:hover { border-color: var(--accent); }
  input { font: inherit; background: #0d1117; color: var(--fg);
    border: 1px solid var(--border); border-radius: 6px; padding: 5px 8px; width: 100%; }
  .row { display: flex; gap: 6px; margin: 6px 0; }
  .feed { max-height: 70vh; overflow: auto; }
  .ev { display: flex; gap: 8px; padding: 3px 0; border-bottom: 1px solid #21262d; }
  .ev .t { color: var(--muted); white-space: nowrap; }
  .ev .ty { color: var(--purple); white-space: nowrap; }
  .worker { padding: 3px 0; border-bottom: 1px solid #21262d; }
  .muted { color: var(--muted); }
</style>
</head>
<body>
<header>
  <span class="dot" id="live"></span>
  <span class="title">Arterm · HQ</span>
  <span id="model" class="muted"></span>
  <span class="badge" id="mode"></span>
  <span class="pill idle" id="status">idle</span>
</header>
<main>
  <div>
    <div class="panel">
      <h2>Session</h2>
      <div class="kv"><span class="k">context</span><span id="ctx">0</span></div>
      <div class="bar"><i id="ctxbar" style="width:0%"></i></div>
      <div class="kv"><span class="k">tokens in</span><span id="tin">0</span></div>
      <div class="kv"><span class="k">tokens out</span><span id="tout">0</span></div>
      <div class="kv"><span class="k">rounds</span><span id="rounds">0</span></div>
      <div class="kv"><span class="k">active tool</span><span id="tool">—</span></div>
    </div>
    <div class="panel">
      <h2>Autonomy</h2>
      <div class="kv"><span class="k">state</span><span id="astate">idle</span></div>
      <div class="kv"><span class="k">mode</span><span id="amode">—</span></div>
      <div class="kv"><span class="k">step</span><span id="astep">0</span></div>
      <div class="muted" id="agoal" style="margin:6px 0"></div>
      <div id="phases"></div>
      <div class="row"><button onclick="ctl('pause')">Pause</button>
        <button onclick="ctl('resume')">Resume</button>
        <button onclick="ctl('stop')">Stop</button></div>
      <div class="row"><input id="steer" placeholder="steer note…" />
        <button onclick="send('steer','steer')">Steer</button></div>
      <div class="row"><input id="goal" placeholder="new goal…" />
        <button onclick="send('goal','goal')">Goal</button></div>
    </div>
    <div class="panel">
      <h2>Fleet</h2>
      <div class="kv"><span class="k">active</span><span id="factive">0</span></div>
      <div class="kv"><span class="k">round</span><span id="fround">0</span></div>
      <div id="workers"></div>
    </div>
  </div>
  <div class="panel">
    <h2>Event feed</h2>
    <div class="row"><input id="filter" placeholder="filter events…" oninput="render()" /></div>
    <div class="feed" id="feed"></div>
  </div>
</main>
<script>
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
  let events = [];
  let st = {};

  function summary(ev) {
    switch (ev.type) {
      case 'tool_call': return ev.call.name + '(' + Object.keys(ev.call.arguments||{}).join(', ') + ')';
      case 'tool_result': return ev.name + (ev.isError ? ' ✗' : ' ✓');
      case 'tool_denied': return ev.name + ' denied';
      case 'assistant_message': return (ev.message.content||'').slice(0, 120);
      case 'goal_set': return ev.goal + ' [' + ev.mode + ']';
      case 'autonomy_step': return 'step ' + ev.step;
      case 'autonomy_reflect': return ev.done ? 'done' : (ev.note||'continue');
      case 'phase_start': return ev.index + '/' + ev.total + ' ' + ev.title;
      case 'phase_done': return ev.title + ' ✓';
      case 'error': return ev.error;
      default: return Object.keys(ev).filter((k) => k!=='type'&&k!=='seq'&&k!=='ts').map((k)=>k).join(' ');
    }
  }
  function render() {
    const f = $('filter').value.toLowerCase();
    const rows = events.slice().reverse().filter((e) => !f ||
      (e.type + ' ' + summary(e)).toLowerCase().includes(f));
    $('feed').innerHTML = rows.map((e) =>
      '<div class="ev"><span class="t">' + new Date(e.ts).toLocaleTimeString() +
      '</span><span class="ty">' + esc(e.type) + '</span><span>' + esc(summary(e)) + '</span></div>'
    ).join('');
  }
  function applyState(s) {
    st = s;
    $('model').textContent = (s.provider||'') + ' · ' + (s.model||'');
    $('mode').textContent = s.permissionMode || '';
    const stp = $('status'); stp.textContent = s.status; stp.className = 'pill ' + s.status;
    $('ctx').textContent = (s.tokens.ctx||0).toLocaleString();
    $('ctxbar').style.width = Math.min(100, (s.tokens.ctx||0)/1000) + '%';
    $('tin').textContent = (s.tokens.in||0).toLocaleString();
    $('tout').textContent = (s.tokens.out||0).toLocaleString();
    $('rounds').textContent = s.rounds||0;
    $('tool').textContent = s.activeTool || '—';
    const a = s.autonomy || {};
    $('astate').textContent = a.state || 'idle';
    $('amode').textContent = a.mode || '—';
    $('astep').textContent = a.step || 0;
    $('agoal').textContent = a.goal || '';
    $('phases').innerHTML = (a.phases||[]).map((p, i) =>
      '<div class="kv"><span class="k">' + (i+1) + (p.parallel ? ' ∥' : '') + '</span><span>' +
      esc(p.title) + '</span></div>').join('');
    $('factive').textContent = (s.fleet||{}).active || 0;
    $('fround').textContent = (s.fleet||{}).round || 0;
    $('workers').innerHTML = (s.workers||[]).map((w) =>
      '<div class="worker">' + (w.state==='done'?'✓':'▸') + ' ' + esc(w.task) +
      (w.role ? ' <span class="muted">['+esc(w.role)+']</span>' : '') + '</div>').join('');
  }
  async function ctl(action) {
    await fetch('/api/control', { method: 'POST', headers: {'content-type':'application/json'},
      body: JSON.stringify({ action }) });
  }
  async function send(inputId, action) {
    const el = $(inputId); const note = el.value.trim(); if (!note) return;
    await fetch('/api/control', { method: 'POST', headers: {'content-type':'application/json'},
      body: JSON.stringify({ action, note }) });
    el.value = '';
  }
  const es = new EventSource('/api/stream');
  es.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'snapshot') { events = msg.events || []; applyState(msg.state); render(); }
    else if (msg.type === 'event') { events.push(msg.event); if (events.length > 500) events.shift(); render(); }
    else if (msg.type === 'state') { applyState(msg.state); }
    $('live').classList.add('live');
  };
  es.onerror = () => $('live').classList.remove('live');
</script>
</body>
</html>`;
