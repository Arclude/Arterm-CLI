import type { StampedEvent } from "./hqState.js";

/**
 * Wire protocol for the multi-agent HQ: agent processes push their live state to a
 * central aggregator over WS `/agent`; web clients subscribe over WS `/ui` and route
 * control back. All messages are JSON with a `t` discriminator.
 */

/** One monitored agent's identity + liveness, as tracked by the aggregator. */
export interface AgentMeta {
  id: string;
  cwd: string;
  model: string;
  provider: string;
  mode: string;
  startedAt: number;
  online: boolean;
}

/** Agent → aggregator (WS `/agent`). */
export type AgentMsg =
  | { t: "register"; meta: Omit<AgentMeta, "online"> }
  | { t: "snapshot"; state: Record<string, unknown>; events: StampedEvent[] }
  | { t: "event"; event: StampedEvent }
  | { t: "state"; state: Record<string, unknown> };

/** Aggregator → agent (WS `/agent`). */
export type ToAgentMsg = { t: "control"; action: string; note?: string };

/** Web UI → aggregator (WS `/ui`). */
export type UiMsg =
  | { t: "subscribe"; agentId: string }
  | { t: "control"; agentId: string; action: string; note?: string };

/** Aggregator → web UI (WS `/ui`). */
export type ToUiMsg =
  | { t: "agents"; agents: AgentMeta[] }
  | { t: "snapshot"; agentId: string; state: Record<string, unknown>; events: StampedEvent[] }
  | { t: "event"; agentId: string; event: StampedEvent }
  | { t: "state"; agentId: string; state: Record<string, unknown> };

/** Default port for the aggregator (distinct from the single-agent server's 7777). */
export const HQ_AGGREGATOR_PORT = 7788;
