import { afterEach, describe, expect, it } from "vitest";
import { type HqAggregator, startHqAggregator } from "./hqAggregator.js";

// Uses the global (undici) `WebSocket` client — the browser-style API the real web UI
// uses, and the one that works inside vitest's worker (the `ws` client does not).

const running: HqAggregator[] = [];
afterEach(async () => {
  while (running.length) await running.pop()?.close();
});

async function start(): Promise<HqAggregator> {
  const agg = await startHqAggregator({ port: 0 });
  running.push(agg);
  return agg;
}

function open(url: string): Promise<WebSocket> {
  const ws = new WebSocket(url);
  return new Promise((resolve, reject) => {
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error("ws error"));
  });
}

/** Resolve the next JSON message matching `pred`. */
function next<T>(ws: WebSocket, pred: (m: T) => boolean): Promise<T> {
  return new Promise((resolve) => {
    const on = (e: MessageEvent) => {
      const m = JSON.parse(String(e.data)) as T;
      if (pred(m)) {
        ws.removeEventListener("message", on);
        resolve(m);
      }
    };
    ws.addEventListener("message", on);
  });
}

const wsBase = (agg: HqAggregator) => agg.url.replace(/^http/, "ws");
const register = (id: string) =>
  JSON.stringify({
    t: "register",
    meta: { id, cwd: "/x", model: "m", provider: "p", mode: "auto", startedAt: 1 },
  });

describe("hqAggregator", () => {
  it("registers an agent and lists it to a UI client", async () => {
    const agg = await start();
    const agent = await open(`${wsBase(agg)}/agent`);
    agent.send(register("a1"));
    const ui = await open(`${wsBase(agg)}/ui`);
    const agents = await next<{ t: string; agents: { id: string; online: boolean }[] }>(
      ui,
      (m) => m.t === "agents" && m.agents.some((a) => a.id === "a1"),
    );
    expect(agents.agents.find((a) => a.id === "a1")?.online).toBe(true);
    agent.close();
    ui.close();
  });

  it("broadcasts an agent event to UI clients", async () => {
    const agg = await start();
    const agent = await open(`${wsBase(agg)}/agent`);
    agent.send(register("a2"));
    const ui = await open(`${wsBase(agg)}/ui`);
    await next(ui, (m: { t: string }) => m.t === "agents");
    agent.send(JSON.stringify({ t: "event", event: { seq: 1, ts: 1, type: "turn_start" } }));
    const ev = await next<{ t: string; agentId: string; event: { type: string } }>(
      ui,
      (m) => m.t === "event",
    );
    expect(ev.agentId).toBe("a2");
    expect(ev.event.type).toBe("turn_start");
    agent.close();
    ui.close();
  });

  it("routes a UI control message back to the agent", async () => {
    const agg = await start();
    const agent = await open(`${wsBase(agg)}/agent`);
    agent.send(register("a3"));
    const ui = await open(`${wsBase(agg)}/ui`);
    await next(ui, (m: { t: string }) => m.t === "agents");
    const gotControl = next<{ t: string; action: string; note?: string }>(
      agent,
      (m) => m.t === "control",
    );
    ui.send(JSON.stringify({ t: "control", agentId: "a3", action: "steer", note: "go" }));
    const ctl = await gotControl;
    expect(ctl.action).toBe("steer");
    expect(ctl.note).toBe("go");
    agent.close();
    ui.close();
  });

  it("serves /api/agents over HTTP", async () => {
    const agg = await start();
    const res = await fetch(`${agg.url}/api/agents`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { agents: unknown[] };
    expect(Array.isArray(body.agents)).toBe(true);
  });
});
