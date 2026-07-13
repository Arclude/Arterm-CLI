import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import type { Session } from "@arterm/tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { STATUS_DIR, type StatusServer, startStatusServer } from "./statusServer.js";

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

function makeSession() {
  const bus = new FakeBus();
  const autonomy = {
    snapshot: vi.fn(() => ({
      state: "idle",
      mode: "once",
      goal: "",
      step: 0,
      phases: [],
      team: [],
    })),
    pause: vi.fn(),
    resume: vi.fn(),
    stop: vi.fn(),
    steer: vi.fn(),
    start: vi.fn().mockResolvedValue(undefined),
    setMode: vi.fn(() => true),
  };
  const session = {
    bus,
    agent: { model: "test-model" },
    providerLabel: "test-provider",
    permissionMode: "ask",
    toolCount: 3,
    autonomy,
  };
  return { bus, autonomy, session: session as unknown as Session };
}

/** Test helper: JSON responses are probed with arbitrary shapes. */
const asJson = (res: Response): Promise<any> => res.json() as Promise<any>;

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

async function start(): Promise<{ server: StatusServer; session: ReturnType<typeof makeSession> }> {
  const session = makeSession();
  const server = await startStatusServer({ session: session.session, cwd: "/w" });
  cleanups.push(() => server.close());
  return { server, session };
}

describe("statusServer", () => {
  it("serves /api/health without a token", async () => {
    const { server } = await start();
    const res = await fetch(`${server.url}/api/health`);
    expect(res.status).toBe(200);
    const body = await asJson(res);
    expect(body.v).toBe(1);
    expect(body.ok).toBe(true);
    expect(body.pid).toBe(process.pid);
  });

  it("rejects unauthenticated /api/state with 401", async () => {
    const { server } = await start();
    const res = await fetch(`${server.url}/api/state`);
    expect(res.status).toBe(401);
  });

  it("serves /api/state with query token and bearer header", async () => {
    const { server } = await start();
    const viaQuery = await fetch(`${server.url}/api/state?token=${server.token}`);
    expect(viaQuery.status).toBe(200);
    const body = await asJson(viaQuery);
    expect(body.v).toBe(1);
    expect(body.state.status).toBe("idle");
    expect(body.state.activeAgents).toBe(0);

    const viaHeader = await fetch(`${server.url}/api/state`, {
      headers: { authorization: `Bearer ${server.token}` },
    });
    expect(viaHeader.status).toBe(200);
  });

  it("rejects non-loopback Host headers (DNS rebinding guard)", async () => {
    const { server } = await start();
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port: server.port,
          path: "/api/health",
          headers: { host: "evil.example.com" },
        },
        (res) => resolve(res.statusCode ?? 0),
      );
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(403);
  });

  it("returns 405 for wrong methods and 404 for unknown routes", async () => {
    const { server } = await start();
    const post = await fetch(`${server.url}/api/state?token=${server.token}`, { method: "POST" });
    expect(post.status).toBe(405);
    const unknown = await fetch(`${server.url}/api/nope?token=${server.token}`);
    expect(unknown.status).toBe(404);
  });

  it("streams SSE starting with a snapshot frame and then live events", async () => {
    const { server, session } = await start();
    const controller = new AbortController();
    cleanups.push(() => controller.abort());

    const res = await fetch(`${server.url}/api/stream?token=${server.token}`, {
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const reader = res.body?.getReader();
    if (!reader) throw new Error("no body");
    const decoder = new TextDecoder();
    let buffer = "";
    const readUntil = async (marker: string): Promise<void> => {
      while (!buffer.includes(marker)) {
        const { value, done } = await reader.read();
        if (done) throw new Error(`stream ended before ${marker}`);
        buffer += decoder.decode(value, { stream: true });
      }
    };

    await readUntil("event: snapshot");
    expect(buffer).toContain('"v":1');

    session.bus.emit({ type: "assistant_message", content: "hi" });
    await readUntil("event: agent");
    expect(buffer).toContain('"type":"assistant_message"');
    controller.abort();
  });

  it("dispatches control actions and reports unknown ones as ok:false", async () => {
    const { server, session } = await start();
    const pause = await fetch(`${server.url}/api/control?token=${server.token}`, {
      method: "POST",
      body: JSON.stringify({ action: "pause" }),
    });
    expect(pause.status).toBe(200);
    const pauseBody = await asJson(pause);
    expect(pauseBody.ok).toBe(true);
    expect(pauseBody.state.v).toBe(1);
    expect(session.autonomy.pause).toHaveBeenCalled();

    const unknown = await fetch(`${server.url}/api/control?token=${server.token}`, {
      method: "POST",
      body: JSON.stringify({ action: "explode" }),
    });
    expect(unknown.status).toBe(200);
    expect((await asJson(unknown)).ok).toBe(false);
  });

  it("rejects malformed control bodies with 400", async () => {
    const { server } = await start();
    const res = await fetch(`${server.url}/api/control?token=${server.token}`, {
      method: "POST",
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });

  it("writes a discovery file while open and removes it on close", async () => {
    const session = makeSession();
    const server = await startStatusServer({ session: session.session, cwd: "/w" });
    const file = join(STATUS_DIR, `${process.pid}.json`);
    try {
      expect(existsSync(file)).toBe(true);
      const entry = JSON.parse(await (await import("node:fs/promises")).readFile(file, "utf8"));
      expect(entry.v).toBe(1);
      expect(entry.port).toBe(server.port);
      expect(entry.token).toBe(server.token);
      expect(entry.model).toBe("test-model");
    } finally {
      await server.close();
    }
    expect(existsSync(file)).toBe(false);
  });

  it("sweeps stale discovery files from dead pids on start", async () => {
    mkdirSync(STATUS_DIR, { recursive: true });
    const deadPid = 1073741823; // not a plausible live pid
    const staleFile = join(STATUS_DIR, `${deadPid}.json`);
    writeFileSync(staleFile, JSON.stringify({ v: 1, pid: deadPid, port: 1, token: "x" }));
    cleanups.push(() => {
      try {
        unlinkSync(staleFile);
      } catch {}
    });

    const { server } = await start();
    expect(server.port).toBeGreaterThan(0);
    expect(existsSync(staleFile)).toBe(false);
  });
});
