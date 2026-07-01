"use client";

import { useEffect, useState } from "react";
import type { AgentState, StampedEvent } from "./types";
import { type Hq, useHq } from "./useHq";

function basename(p: string): string {
  const parts = p.replace(/[/\\]+$/, "").split(/[/\\]/);
  return parts[parts.length - 1] || p;
}

function summary(ev: StampedEvent): string {
  const e = ev as Record<string, any>;
  switch (ev.type) {
    case "tool_call":
      return `${e.call.name}(${Object.keys(e.call.arguments || {}).join(", ")})`;
    case "tool_result":
      return `${e.name}${e.isError ? " ✗" : " ✓"}`;
    case "tool_denied":
      return `${e.name} denied`;
    case "assistant_message":
      return String(e.message?.content || "").slice(0, 140);
    case "goal_set":
      return `${e.goal} [${e.mode}]`;
    case "autonomy_step":
      return `step ${e.step}`;
    case "autonomy_reflect":
      return e.done ? "done" : e.note || "continue";
    case "phase_start":
      return `${e.index}/${e.total} ${e.title}`;
    case "phase_done":
      return `${e.title} ✓`;
    case "error":
      return String(e.error);
    default:
      return "";
  }
}

function Detail({ hq, id }: { hq: Hq; id: string }) {
  const s: AgentState | undefined = hq.states[id];
  const events = hq.events[id] ?? [];
  const [steer, setSteer] = useState("");
  const [goal, setGoal] = useState("");
  const [filter, setFilter] = useState("");

  useEffect(() => {
    hq.subscribe(id);
  }, [hq, id]);

  if (!s) return <div className="empty">Waiting for state…</div>;
  const a = s.autonomy;
  const rows = events
    .slice()
    .reverse()
    .filter(
      (e) => !filter || `${e.type} ${summary(e)}`.toLowerCase().includes(filter.toLowerCase()),
    );

  return (
    <>
      <div className="header">
        <strong style={{ color: "var(--accent)" }}>{s.model}</strong>
        <span className="badge">{s.provider}</span>
        <span className="badge">{s.permissionMode}</span>
        <span className={`pill ${s.status}`}>{s.status}</span>
        <span className="badge">{s.toolCount} tools</span>
      </div>
      <div className="grid">
        <div>
          <div className="panel">
            <h2>Session</h2>
            <div className="kv">
              <span className="k">context</span>
              <span>{s.tokens.ctx.toLocaleString()}</span>
            </div>
            <div className="bar">
              <i style={{ width: `${Math.min(100, s.tokens.ctx / 1000)}%` }} />
            </div>
            <div className="kv">
              <span className="k">tokens in</span>
              <span>{s.tokens.in.toLocaleString()}</span>
            </div>
            <div className="kv">
              <span className="k">tokens out</span>
              <span>{s.tokens.out.toLocaleString()}</span>
            </div>
            <div className="kv">
              <span className="k">rounds</span>
              <span>{s.rounds}</span>
            </div>
            <div className="kv">
              <span className="k">active tool</span>
              <span>{s.activeTool || "—"}</span>
            </div>
          </div>
          <div className="panel">
            <h2>Autonomy</h2>
            <div className="kv">
              <span className="k">state</span>
              <span>{a.state}</span>
            </div>
            <div className="kv">
              <span className="k">mode</span>
              <span>{a.mode}</span>
            </div>
            <div className="kv">
              <span className="k">step</span>
              <span>{a.step}</span>
            </div>
            {a.goal ? <div style={{ color: "var(--muted)", margin: "6px 0" }}>{a.goal}</div> : null}
            {a.phases.map((p, i) => (
              <div className="kv" key={p.id}>
                <span className="k">
                  {i + 1}
                  {p.parallel ? " ∥" : ""}
                </span>
                <span>{p.title}</span>
              </div>
            ))}
            <div className="controls">
              <button type="button" className="act" onClick={() => hq.control(id, "pause")}>
                Pause
              </button>
              <button type="button" className="act" onClick={() => hq.control(id, "resume")}>
                Resume
              </button>
              <button type="button" className="act" onClick={() => hq.control(id, "stop")}>
                Stop
              </button>
            </div>
            <div className="controls">
              <input
                className="act"
                placeholder="steer note…"
                value={steer}
                onChange={(e) => setSteer(e.target.value)}
              />
              <button
                type="button"
                className="act"
                onClick={() => {
                  if (steer.trim()) hq.control(id, "steer", steer.trim());
                  setSteer("");
                }}
              >
                Steer
              </button>
            </div>
            <div className="controls">
              <input
                className="act"
                placeholder="new goal…"
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
              />
              <button
                type="button"
                className="act"
                onClick={() => {
                  if (goal.trim()) hq.control(id, "goal", goal.trim());
                  setGoal("");
                }}
              >
                Goal
              </button>
            </div>
          </div>
          <div className="panel">
            <h2>Fleet</h2>
            <div className="kv">
              <span className="k">active</span>
              <span>{s.fleet.active}</span>
            </div>
            <div className="kv">
              <span className="k">round</span>
              <span>{s.fleet.round}</span>
            </div>
            {s.workers.map((w, i) => (
              <div className="worker" key={`${w.task}-${i}`}>
                {w.state === "done" ? "✓" : "▸"} {w.task}
                {w.role ? <span style={{ color: "var(--muted)" }}> [{w.role}]</span> : null}
              </div>
            ))}
          </div>
        </div>
        <div className="panel">
          <h2>Event feed</h2>
          <div className="controls">
            <input
              className="act"
              placeholder="filter events…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          </div>
          <div className="feed">
            {rows.map((e) => (
              <div className="ev" key={e.seq}>
                <span className="t">{new Date(e.ts).toLocaleTimeString()}</span>
                <span className="ty">{e.type}</span>
                <span>{summary(e)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

export default function Page() {
  const hq = useHq();
  const [sel, setSel] = useState<string | null>(null);

  // Auto-select the first online agent once one appears.
  useEffect(() => {
    if (!sel && hq.agents.length > 0) {
      setSel(hq.agents.find((a) => a.online)?.id ?? hq.agents[0].id);
    }
  }, [hq.agents, sel]);

  return (
    <div className="app">
      <div className="sidebar">
        <div className="brand">
          <span className={`dot ${hq.connected ? "on" : "off"}`} />
          Arterm · HQ
        </div>
        {hq.agents.length === 0 ? (
          <div className="empty">
            No agents.
            <br />
            Run <code>arterm --hq-connect …</code>
          </div>
        ) : (
          hq.agents.map((ag) => {
            const st = hq.states[ag.id];
            return (
              <button
                type="button"
                key={ag.id}
                className={`agent-item${sel === ag.id ? " sel" : ""}`}
                onClick={() => setSel(ag.id)}
              >
                <span className="row">
                  <span className={`dot ${ag.online ? "on" : "off"}`} />
                  <span className="cwd">{basename(ag.cwd)}</span>
                </span>
                <span className="sub">
                  {ag.model} · {st?.status ?? (ag.online ? "…" : "offline")}
                </span>
              </button>
            );
          })
        )}
      </div>
      <div className="detail">
        {sel ? <Detail hq={hq} id={sel} /> : <div className="empty">Select an agent.</div>}
      </div>
    </div>
  );
}
