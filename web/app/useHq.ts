"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentMeta, AgentState, StampedEvent, ToUiMsg } from "./types";

const RING = 500;

/** Resolve the aggregator `/ui` WebSocket URL (dev override via NEXT_PUBLIC_HQ_WS). */
function wsUrl(): string {
  const env = process.env.NEXT_PUBLIC_HQ_WS;
  if (env) return env;
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${window.location.host}/ui`;
}

export interface Hq {
  connected: boolean;
  agents: AgentMeta[];
  states: Record<string, AgentState | undefined>;
  events: Record<string, StampedEvent[] | undefined>;
  subscribe(agentId: string): void;
  control(agentId: string, action: string, note?: string): void;
}

export function useHq(): Hq {
  const [connected, setConnected] = useState(false);
  const [agents, setAgents] = useState<AgentMeta[]>([]);
  const [states, setStates] = useState<Record<string, AgentState | undefined>>({});
  const [events, setEvents] = useState<Record<string, StampedEvent[] | undefined>>({});
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      if (closed) return;
      const ws = new WebSocket(wsUrl());
      wsRef.current = ws;
      ws.onopen = () => setConnected(true);
      ws.onclose = () => {
        setConnected(false);
        if (!closed) retry = setTimeout(connect, 2000);
      };
      ws.onerror = () => ws.close();
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data) as ToUiMsg;
        if (msg.t === "agents") {
          setAgents(msg.agents);
        } else if (msg.t === "snapshot") {
          setStates((s) => ({ ...s, [msg.agentId]: msg.state }));
          setEvents((v) => ({ ...v, [msg.agentId]: msg.events }));
        } else if (msg.t === "state") {
          setStates((s) => ({ ...s, [msg.agentId]: msg.state }));
        } else if (msg.t === "event") {
          setEvents((v) => {
            const prev = v[msg.agentId] ?? [];
            const nextRing = [...prev, msg.event];
            if (nextRing.length > RING) nextRing.shift();
            return { ...v, [msg.agentId]: nextRing };
          });
        }
      };
    };
    connect();

    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      wsRef.current?.close();
    };
  }, []);

  const send = useCallback((obj: unknown) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }, []);

  const subscribe = useCallback((agentId: string) => send({ t: "subscribe", agentId }), [send]);
  const control = useCallback(
    (agentId: string, action: string, note?: string) =>
      send({ t: "control", agentId, action, note }),
    [send],
  );

  return { connected, agents, states, events, subscribe, control };
}
