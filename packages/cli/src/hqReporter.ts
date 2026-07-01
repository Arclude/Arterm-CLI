import { randomUUID } from "node:crypto";
import type { Session } from "@arterm/tui";
import WebSocket from "ws";
import type { AgentMsg, ToAgentMsg } from "./hqProtocol.js";
import { HqState, control } from "./hqState.js";

/**
 * Agent-side **reporter**: streams THIS session's live state to a multi-agent HQ
 * aggregator over WS `/agent`, and applies control commands routed back from the UI.
 * Reuses the shared `HqState` accumulator; transparently reconnects if the aggregator
 * restarts, until `close()`.
 */
export interface HqReporter {
  close: () => void;
}

/** Convert an http(s) aggregator URL to its ws(s) `/agent` endpoint. */
function agentWsUrl(base: string): string {
  return `${base.replace(/^http/, "ws").replace(/\/+$/, "")}/agent`;
}

export function connectHqReporter(opts: {
  session: Session;
  url: string;
  cwd: string;
}): HqReporter {
  const { session } = opts;
  const state = new HqState(session);
  const wsUrl = agentWsUrl(opts.url);
  const meta = {
    id: randomUUID(),
    cwd: opts.cwd,
    model: session.agent.model,
    provider: session.providerLabel,
    mode: session.permissionMode,
    startedAt: Date.now(),
  };

  let ws: WebSocket | undefined;
  let unsubscribe: (() => void) | undefined;
  let retry: NodeJS.Timeout | undefined;
  let closed = false;

  const send = (msg: AgentMsg): void => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };

  const connect = (): void => {
    if (closed) return;
    ws = new WebSocket(wsUrl);

    ws.on("open", () => {
      send({ t: "register", meta });
      send({ t: "snapshot", state: state.snapshot(), events: state.events() });
      // Forward the shared accumulator's pushes, re-tagged to the wire protocol.
      unsubscribe = state.addSubscriber((chunk) => {
        const m = JSON.parse(chunk) as { type: string; event?: unknown; state?: unknown };
        if (m.type === "event") send({ t: "event", event: m.event as never });
        else if (m.type === "state")
          send({ t: "state", state: m.state as Record<string, unknown> });
      });
    });

    ws.on("message", (raw) => {
      let msg: ToAgentMsg;
      try {
        msg = JSON.parse(String(raw)) as ToAgentMsg;
      } catch {
        return;
      }
      if (msg.t === "control") control(session, msg.action, (msg.note ?? "").trim());
    });

    const reconnect = (): void => {
      unsubscribe?.();
      unsubscribe = undefined;
      if (closed) return;
      retry = setTimeout(connect, 2000);
    };
    ws.on("close", reconnect);
    ws.on("error", () => ws?.close());
  };

  connect();

  return {
    close: () => {
      closed = true;
      if (retry) clearTimeout(retry);
      unsubscribe?.();
      state.dispose();
      ws?.close();
    },
  };
}
