import type { Session } from "@arterm/tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type HqServer, startHqServer } from "./hqServer.js";

// Minimal stand-ins so the test pulls no workspace runtime deps (Session/AgentEvent
// are type-only in hqServer.ts and erased at runtime).
type Listener = (event: { type: string; [k: string]: unknown }) => void;

class FakeBus {
  private readonly listeners = new Set<Listener>();
  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(event: { type: string; [k: string]: unknown }): void {
    for (const listener of this.listeners) listener(event);
  }
}

function makeSession(): {
  session: Session;
  bus: FakeBus;
  autonomy: Record<string, ReturnType<typeof vi.fn>>;
} {
  const bus = new FakeBus();
  const autonomy = {
    pause: vi.fn(),
    resume: vi.fn(),
    stop: vi.fn(),
    steer: vi.fn(),
    start: vi.fn(async () => {}),
    snapshot: vi.fn(() => ({ state: "idle", mode: "once", goal: "", step: 0, phases: [] })),
  };
  const session = {
    bus,
    autonomy,
    providerLabel: "ollama",
    permissionMode: "auto",
    toolCount: 19,
    agent: { model: "qwen2.5-coder:7b" },
  };
  return { session: session as unknown as Session, bus, autonomy };
}

const servers: HqServer[] = [];
async function start(session: Session): Promise<HqServer> {
  // port 0 → ephemeral; startHqServer surfaces the real bound port in `url`.
  const s = await startHqServer({ session, port: 0 });
  servers.push(s);
  return s;
}

afterEach(async () => {
  while (servers.length) await servers.pop()?.close();
  vi.restoreAllMocks();
});

describe("hqServer", () => {
  it("GET /api/state returns the derived snapshot shape", async () => {
    const { session } = makeSession();
    const srv = await start(session);
    const res = await fetch(`${srv.url}/api/state`);
    expect(res.status).toBe(200);
    const state = (await res.json()) as Record<string, unknown>;
    expect(state.status).toBe("idle");
    expect(state.model).toBe("qwen2.5-coder:7b");
    expect(state.provider).toBe("ollama");
    expect(state).toHaveProperty("tokens");
    expect(state).toHaveProperty("autonomy");
    expect(state).toHaveProperty("workers");
    expect(state).toHaveProperty("fleet");
  });

  it("reflects a usage event into token counters", async () => {
    const { session, bus } = makeSession();
    const srv = await start(session);
    bus.emit({ type: "usage", usage: { promptTokens: 100, completionTokens: 20 } });
    const state = (await (await fetch(`${srv.url}/api/state`)).json()) as {
      tokens: { in: number; out: number; ctx: number };
    };
    expect(state.tokens.in).toBe(100);
    expect(state.tokens.ctx).toBe(100);
    expect(state.tokens.out).toBe(20);
  });

  it("SSE stream opens with a snapshot frame", async () => {
    const { session } = makeSession();
    const srv = await start(session);
    const res = await fetch(`${srv.url}/api/stream`);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    expect(text.startsWith("data: ")).toBe(true);
    const msg = JSON.parse(text.slice("data: ".length).trim()) as { type: string };
    expect(msg.type).toBe("snapshot");
    await reader.cancel();
  });

  it("POST /api/control dispatches to autonomy methods", async () => {
    const { session, autonomy } = makeSession();
    const srv = await start(session);

    const pause = await fetch(`${srv.url}/api/control`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "pause" }),
    });
    expect(pause.status).toBe(200);
    expect(((await pause.json()) as { ok: boolean }).ok).toBe(true);
    expect(autonomy.pause).toHaveBeenCalledOnce();

    await fetch(`${srv.url}/api/control`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "steer", note: "focus on tests" }),
    });
    expect(autonomy.steer).toHaveBeenCalledWith("focus on tests");

    await fetch(`${srv.url}/api/control`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "goal", note: "ship it" }),
    });
    expect(autonomy.start).toHaveBeenCalledWith("ship it");
  });

  it("rejects an unknown control action with 400", async () => {
    const { session } = makeSession();
    const srv = await start(session);
    const res = await fetch(`${srv.url}/api/control`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "explode" }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(false);
  });

  it("404s an unknown path", async () => {
    const { session } = makeSession();
    const srv = await start(session);
    const res = await fetch(`${srv.url}/nope`);
    expect(res.status).toBe(404);
  });

  it("GET / serves the dashboard HTML", async () => {
    const { session } = makeSession();
    const srv = await start(session);
    const res = await fetch(`${srv.url}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("Arterm · HQ");
    expect(html).toContain("/api/stream");
  });
});
