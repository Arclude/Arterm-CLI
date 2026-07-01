import { watch } from "node:fs";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import {
  MEMORY_DIR,
  type MemoryRecord,
  listMemoryProjects,
  projectKey,
  readProjectRecords,
} from "@arterm/core";
import {
  CMEM_DIR,
  type Observation,
  computeSavings,
  listCmemProjects,
  openStoreByKey,
} from "@arterm/memory";

/** A running memory viewer server. */
export interface MemoryServer {
  url: string;
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

/**
 * Start a local HTTP server that serves a live view of persisted project memory
 * (Arterm's equivalent of claude-mem's viewer/worker on a port). Reads the JSONL
 * files under `~/.arterm/memory/`; live-updates via SSE backed by `fs.watch`.
 */
export function startMemoryServer(opts: { cwd: string; port?: number }): Promise<MemoryServer> {
  const dir = MEMORY_DIR;
  const defaultKey = projectKey(opts.cwd);

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    if (path === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(VIEWER_HTML);
      return;
    }

    if (path === "/api/projects") {
      const projects = await listMemoryProjects(dir);
      const withCounts = await Promise.all(
        projects.map(async (p) => ({
          ...p,
          count: (await readProjectRecords(p.key, dir)).length,
          current: p.key === defaultKey,
        })),
      );
      json(res, 200, { projects: withCounts, defaultKey });
      return;
    }

    if (path === "/api/memory") {
      const key = url.searchParams.get("project") || defaultKey;
      const records = await readProjectRecords(key, dir);
      json(res, 200, { project: key, records });
      return;
    }

    if (path === "/api/stream") {
      streamProject(req, res, dir, url.searchParams.get("project") || defaultKey);
      return;
    }

    json(res, 404, { error: "not found" });
  };

  const server = createServer((req, res) => {
    handler(req, res).catch(() => json(res, 500, { error: "internal error" }));
  });

  const port = opts.port ?? 7777;
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

/** Server-Sent Events: push the project's records on every file change. */
function streamProject(req: IncomingMessage, res: ServerResponse, dir: string, key: string): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive",
  });

  const send = async (): Promise<void> => {
    const records = await readProjectRecords(key, dir);
    res.write(`data: ${JSON.stringify({ project: key, records })}\n\n`);
  };
  void send();

  let timer: NodeJS.Timeout | undefined;
  let watcher: ReturnType<typeof watch> | undefined;
  try {
    // Watch the directory (the file may not exist yet) and debounce bursts.
    watcher = watch(dir, (_event, filename) => {
      if (filename && !String(filename).startsWith(`${key}`)) return;
      clearTimeout(timer);
      timer = setTimeout(() => void send(), 150);
    });
  } catch {
    // Without fs.watch the client still has its initial snapshot + polling.
  }

  const keepAlive = setInterval(() => res.write(": ping\n\n"), 25_000);

  req.on("close", () => {
    clearInterval(keepAlive);
    clearTimeout(timer);
    watcher?.close();
    res.end();
  });
}

// --- cmem (rich observation) viewer -----------------------------------------

/** Read one project's observations from its cmem store (best-effort). */
async function readCmemObservations(key: string): Promise<Observation[]> {
  const store = await openStoreByKey(key);
  try {
    return await store.all();
  } finally {
    store.close();
  }
}

/**
 * Start a local HTTP server that serves a live view of the RICH cmem memory
 * (typed observations, subtitle/facts/narrative/concepts, token savings) — the
 * cmem-engine analog of {@link startMemoryServer}. Reads `~/.arterm/cmem/`.
 */
export function startCmemServer(opts: { cwd: string; port?: number }): Promise<MemoryServer> {
  const dir = CMEM_DIR;
  const defaultKey = projectKey(opts.cwd);

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    if (path === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(CMEM_VIEWER_HTML);
      return;
    }

    if (path === "/api/projects") {
      const projects = await listCmemProjects(dir);
      const withCounts = await Promise.all(
        projects.map(async (p) => ({
          ...p,
          count: (await readCmemObservations(p.key)).length,
          current: p.key === defaultKey,
        })),
      );
      json(res, 200, { projects: withCounts, defaultKey });
      return;
    }

    if (path === "/api/memory") {
      const key = url.searchParams.get("project") || defaultKey;
      const observations = await readCmemObservations(key);
      json(res, 200, { project: key, observations, savings: computeSavings(observations) });
      return;
    }

    if (path === "/api/stream") {
      streamCmem(req, res, dir, url.searchParams.get("project") || defaultKey);
      return;
    }

    json(res, 404, { error: "not found" });
  };

  const server = createServer((req, res) => {
    handler(req, res).catch(() => json(res, 500, { error: "internal error" }));
  });

  const port = opts.port ?? 7777;
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

/** SSE: push a project's observations + savings on every cmem file change. */
function streamCmem(req: IncomingMessage, res: ServerResponse, dir: string, key: string): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive",
  });

  const send = async (): Promise<void> => {
    const observations = await readCmemObservations(key);
    res.write(
      `data: ${JSON.stringify({ project: key, observations, savings: computeSavings(observations) })}\n\n`,
    );
  };
  void send();

  let timer: NodeJS.Timeout | undefined;
  let watcher: ReturnType<typeof watch> | undefined;
  try {
    watcher = watch(dir, (_event, filename) => {
      if (filename && !String(filename).startsWith(`${key}`)) return;
      clearTimeout(timer);
      timer = setTimeout(() => void send(), 150);
    });
  } catch {
    // Without fs.watch the client still has its initial snapshot.
  }

  const keepAlive = setInterval(() => res.write(": ping\n\n"), 25_000);
  req.on("close", () => {
    clearInterval(keepAlive);
    clearTimeout(timer);
    watcher?.close();
    res.end();
  });
}

/** Render records as plain text for `arterm memory ls`. */
export function formatRecordsText(records: MemoryRecord[]): string {
  if (records.length === 0) return "(no memory for this project yet)";
  return records
    .map((r) => {
      const when = new Date(r.ts).toISOString().slice(0, 16).replace("T", " ");
      const files = r.files && r.files.length > 0 ? `  [${r.files.join(", ")}]` : "";
      const body = r.body ? `\n      ${r.body}` : "";
      return `${when}  ${r.type.padEnd(9)} ${r.title}${files}${body}`;
    })
    .join("\n");
}

// Self-contained viewer page — no build step, no framework, no external assets.
const VIEWER_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Arterm · Memory</title>
<style>
  :root {
    --bg: #0e1116; --panel: #161b22; --border: #272e38; --fg: #d7dde4;
    --muted: #8b949e; --accent: #7c9cf5;
    --feature: #3fb950; --bugfix: #f85149; --decision: #d29922;
    --discovery: #a371f7; --note: #58a6ff;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg);
    font: 14px/1.5 ui-monospace, "Cascadia Code", "SF Mono", Menlo, monospace; }
  header { position: sticky; top: 0; background: var(--panel);
    border-bottom: 1px solid var(--border); padding: 14px 20px;
    display: flex; gap: 14px; align-items: center; flex-wrap: wrap; z-index: 5; }
  header h1 { font-size: 15px; margin: 0; letter-spacing: .5px; }
  header h1 span { color: var(--accent); }
  select, input { background: var(--bg); color: var(--fg);
    border: 1px solid var(--border); border-radius: 6px; padding: 6px 10px;
    font: inherit; }
  input { flex: 1; min-width: 180px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--bugfix);
    display: inline-block; }
  .dot.live { background: var(--feature); box-shadow: 0 0 6px var(--feature); }
  .count { color: var(--muted); font-size: 12px; }
  main { padding: 18px 20px; max-width: 980px; margin: 0 auto; }
  .card { background: var(--panel); border: 1px solid var(--border);
    border-radius: 8px; padding: 12px 14px; margin-bottom: 10px; }
  .card .top { display: flex; gap: 10px; align-items: baseline; }
  .badge { font-size: 11px; text-transform: uppercase; letter-spacing: .5px;
    padding: 2px 8px; border-radius: 20px; border: 1px solid; }
  .title { font-weight: 600; flex: 1; }
  .ts { color: var(--muted); font-size: 12px; white-space: nowrap; }
  .body { color: var(--fg); margin-top: 6px; opacity: .92; }
  .files { margin-top: 8px; }
  .file { display: inline-block; background: var(--bg); border: 1px solid var(--border);
    border-radius: 5px; padding: 1px 7px; margin: 2px 4px 0 0; font-size: 12px;
    color: var(--muted); }
  .empty { color: var(--muted); text-align: center; padding: 60px 0; }
</style>
</head>
<body>
<header>
  <h1>Arterm<span>·</span>Memory</h1>
  <span class="dot" id="live" title="connection"></span>
  <select id="project"></select>
  <input id="filter" placeholder="filter…" autocomplete="off" />
  <span class="count" id="count"></span>
</header>
<main id="list"></main>
<script>
const COLORS = { feature:'--feature', bugfix:'--bugfix', decision:'--decision', discovery:'--discovery', note:'--note' };
const $ = (id) => document.getElementById(id);
let records = [], es = null;

function esc(s){ return String(s).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }

function render(){
  const q = $('filter').value.toLowerCase();
  const items = records.filter(r =>
    !q || (r.title + ' ' + (r.body||'') + ' ' + (r.files||[]).join(' ')).toLowerCase().includes(q));
  $('count').textContent = items.length + ' / ' + records.length;
  if (!items.length){ $('list').innerHTML = '<div class="empty">No memory to show.</div>'; return; }
  $('list').innerHTML = items.slice().reverse().map(r => {
    const color = 'var(' + (COLORS[r.type] || '--note') + ')';
    const ts = new Date(r.ts).toLocaleString();
    const files = (r.files||[]).map(f => '<span class="file">'+esc(f)+'</span>').join('');
    return '<div class="card"><div class="top">'
      + '<span class="badge" style="color:'+color+';border-color:'+color+'">'+esc(r.type)+'</span>'
      + '<span class="title">'+esc(r.title)+'</span>'
      + '<span class="ts">'+esc(ts)+'</span></div>'
      + (r.body ? '<div class="body">'+esc(r.body)+'</div>' : '')
      + (files ? '<div class="files">'+files+'</div>' : '')
      + '</div>';
  }).join('');
}

function connect(key){
  if (es) es.close();
  es = new EventSource('/api/stream?project=' + encodeURIComponent(key));
  es.onmessage = (e) => { records = JSON.parse(e.data).records || []; render(); $('live').classList.add('live'); };
  es.onerror = () => $('live').classList.remove('live');
}

async function loadProjects(){
  const { projects, defaultKey } = await (await fetch('/api/projects')).json();
  const sel = $('project');
  sel.innerHTML = projects.map(p => {
    const name = p.cwd.split(/[\\\\/]/).pop() || p.cwd;
    return '<option value="'+p.key+'"'+(p.key===defaultKey?' selected':'')+'>'+esc(name)+' ('+p.count+')</option>';
  }).join('') || '<option>no projects</option>';
  const start = projects.find(p => p.key === defaultKey) ? defaultKey : (projects[0] && projects[0].key);
  if (start) connect(start);
}

$('project').addEventListener('change', e => connect(e.target.value));
$('filter').addEventListener('input', render);
loadProjects();
</script>
</body>
</html>`;

// Rich cmem viewer — typed observations with subtitle/facts/narrative/concepts + savings.
const CMEM_VIEWER_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Arterm · cmem</title>
<style>
  :root {
    --bg: #0e1116; --panel: #161b22; --border: #272e38; --fg: #d7dde4;
    --muted: #8b949e; --accent: #7c9cf5;
    --bugfix: #f85149; --feature: #a371f7; --refactor: #58a6ff;
    --change: #3fb950; --discovery: #56b6c2; --decision: #d29922;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg);
    font: 14px/1.5 ui-monospace, "Cascadia Code", "SF Mono", Menlo, monospace; }
  header { position: sticky; top: 0; background: var(--panel);
    border-bottom: 1px solid var(--border); padding: 14px 20px;
    display: flex; gap: 14px; align-items: center; flex-wrap: wrap; z-index: 5; }
  header h1 { font-size: 15px; margin: 0; letter-spacing: .5px; }
  header h1 span { color: var(--accent); }
  select, input { background: var(--bg); color: var(--fg);
    border: 1px solid var(--border); border-radius: 6px; padding: 6px 10px; font: inherit; }
  input { flex: 1; min-width: 180px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--bugfix); display: inline-block; }
  .dot.live { background: var(--change); box-shadow: 0 0 6px var(--change); }
  .count, .savings { color: var(--muted); font-size: 12px; }
  .savings b { color: var(--change); }
  main { padding: 18px 20px; max-width: 1020px; margin: 0 auto; }
  .card { background: var(--panel); border: 1px solid var(--border);
    border-radius: 8px; padding: 12px 14px; margin-bottom: 10px; }
  .top { display: flex; gap: 10px; align-items: baseline; }
  .id { color: var(--muted); font-size: 12px; }
  .badge { font-size: 11px; text-transform: uppercase; letter-spacing: .5px;
    padding: 2px 8px; border-radius: 20px; border: 1px solid; }
  .title { font-weight: 600; flex: 1; }
  .ts { color: var(--muted); font-size: 12px; white-space: nowrap; }
  .sub { color: var(--fg); opacity: .9; margin-top: 4px; }
  .narr { margin-top: 6px; opacity: .85; }
  ul.facts { margin: 8px 0 0; padding-left: 18px; }
  ul.facts li { opacity: .9; }
  .tags { margin-top: 8px; }
  .tag, .file { display: inline-block; background: var(--bg); border: 1px solid var(--border);
    border-radius: 5px; padding: 1px 7px; margin: 2px 4px 0 0; font-size: 12px; color: var(--muted); }
  .empty { color: var(--muted); text-align: center; padding: 60px 0; }
</style>
</head>
<body>
<header>
  <h1>Arterm<span>·</span>cmem</h1>
  <span class="dot" id="live" title="connection"></span>
  <select id="project"></select>
  <input id="filter" placeholder="filter…" autocomplete="off" />
  <span class="count" id="count"></span>
  <span class="savings" id="savings"></span>
</header>
<main id="list"></main>
<script>
const ICON = { bugfix:'🔴', feature:'🟣', refactor:'🔄', change:'✅', discovery:'🔵', decision:'⚖️' };
const COLOR = { bugfix:'--bugfix', feature:'--feature', refactor:'--refactor', change:'--change', discovery:'--discovery', decision:'--decision' };
const $ = (id) => document.getElementById(id);
let observations = [], savings = null, es = null;

function esc(s){ return String(s).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }

function render(){
  const q = $('filter').value.toLowerCase();
  const items = observations.filter(o =>
    !q || (o.title+' '+(o.subtitle||'')+' '+o.narrative+' '+(o.concepts||[]).join(' ')+' '+(o.facts||[]).join(' ')).toLowerCase().includes(q));
  $('count').textContent = items.length + ' / ' + observations.length;
  $('savings').innerHTML = savings ? 'saved <b>~'+savings.savingsPct+'%</b> ('+savings.discoveryTokens+'→'+savings.readTokens+' tok)' : '';
  if (!items.length){ $('list').innerHTML = '<div class="empty">No observations to show.</div>'; return; }
  $('list').innerHTML = items.slice().reverse().map(o => {
    const color = 'var(' + (COLOR[o.type] || '--discovery') + ')';
    const ts = new Date(o.ts).toLocaleString();
    const facts = (o.facts||[]).map(f => '<li>'+esc(f)+'</li>').join('');
    const concepts = (o.concepts||[]).map(c => '<span class="tag">'+esc(c)+'</span>').join('');
    const files = [...(o.filesModified||[]), ...(o.filesRead||[])].map(f => '<span class="file">'+esc(f)+'</span>').join('');
    return '<div class="card"><div class="top">'
      + '<span class="badge" style="color:'+color+';border-color:'+color+'">'+(ICON[o.type]||'')+' '+esc(o.type)+'</span>'
      + '<span class="title">'+esc(o.title)+'</span>'
      + '<span class="id">#'+o.id+' ~'+o.readTokens+'t</span>'
      + '<span class="ts">'+esc(ts)+'</span></div>'
      + (o.subtitle ? '<div class="sub">'+esc(o.subtitle)+'</div>' : '')
      + (o.narrative ? '<div class="narr">'+esc(o.narrative)+'</div>' : '')
      + (facts ? '<ul class="facts">'+facts+'</ul>' : '')
      + ((concepts||files) ? '<div class="tags">'+concepts+' '+files+'</div>' : '')
      + '</div>';
  }).join('');
}

function connect(key){
  if (es) es.close();
  es = new EventSource('/api/stream?project=' + encodeURIComponent(key));
  es.onmessage = (e) => { const d = JSON.parse(e.data); observations = d.observations || []; savings = d.savings || null; render(); $('live').classList.add('live'); };
  es.onerror = () => $('live').classList.remove('live');
}

async function loadProjects(){
  const { projects, defaultKey } = await (await fetch('/api/projects')).json();
  const sel = $('project');
  sel.innerHTML = projects.map(p => {
    const name = p.cwd.split(/[\\\\/]/).pop() || p.cwd;
    return '<option value="'+p.key+'"'+(p.key===defaultKey?' selected':'')+'>'+esc(name)+' ('+p.count+')</option>';
  }).join('') || '<option>no projects</option>';
  const start = projects.find(p => p.key === defaultKey) ? defaultKey : (projects[0] && projects[0].key);
  if (start) connect(start);
}

$('project').addEventListener('change', e => connect(e.target.value));
$('filter').addEventListener('input', render);
loadProjects();
</script>
</body>
</html>`;
