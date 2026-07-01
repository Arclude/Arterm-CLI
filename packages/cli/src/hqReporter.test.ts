import type { Session } from "@arterm/tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type HqAggregator, startHqAggregator } from "./hqAggregator.js";
import { type HqReporter, connectHqReporter } from "./hqReporter.js";

// End-to-end: fake session → reporter → real aggregator → UI (global WebSocket).

type Listener = (event: { type: string; [k: string]: unknown }) => void;
class FakeBus {
  private readonly listeners = new Set<Listener>();
  on(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  emit(e: { type: string; [k: string]: unknown }): void {
    for (const l of this.listeners) l(e);
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
    agent: { model: "m" },
  };
  return { session: session as unknown as Session, bus, autonomy };
}

const aggs: HqAggregator[] = [];
const reporters: HqReporter[] = [];
afterEach(async () => {
  while (reporters.length) reporters.pop()?.close();
  while (aggs.length) await aggs.pop()?.close();
});

function open(url: string): Promise<WebSocket> {
  const ws = new WebSocket(url);
  return new Promise((resolve, reject) => {
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error("ws error"));
  });
}
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

describe("hqReporter ↔ aggregator", () => {
  it("registers, forwards a bus event, and applies routed control", async () => {
    const agg = await startHqAggregator({ port: 0 });
    aggs.push(agg);
    const wsBase = agg.url.replace(/^http/, "ws");

    const { session, bus, autonomy } = makeSession();
    reporters.push(connectHqReporter({ session, url: agg.url, cwd: "/proj" }));

    const ui = await open(`${wsBase}/ui`);
    const agents = await next<{ t: string; agents: { id: string; cwd: string }[] }>(
      ui,
      (m) => m.t === "agents" && m.agents.length > 0,
    );
    const id = agents.agents[0]?.id as string;
    expect(agents.agents[0]?.cwd).toBe("/proj");

    // A bus event on the session should reach the UI via the reporter→aggregator hop.
    const evP = next<{ t: string; event: { type: string } }>(
      ui,
      (m) => m.t === "event" && m.event.type === "turn_start",
    );
    bus.emit({ type: "turn_start" });
    expect((await evP).event.type).toBe("turn_start");

    // A UI control should route back through the aggregator to the session.
    ui.send(JSON.stringify({ t: "control", agentId: id, action: "pause" }));
    await vi.waitFor(() => expect(autonomy.pause).toHaveBeenCalled());
    ui.close();
  });
});
