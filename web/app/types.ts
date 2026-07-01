// Mirror of the aggregator wire protocol (packages/cli/src/hqProtocol.ts). Duplicated
// across the process boundary — the web app can't import from the CLI build.

export interface AgentMeta {
  id: string;
  cwd: string;
  model: string;
  provider: string;
  mode: string;
  startedAt: number;
  online: boolean;
}

export interface Phase {
  id: string;
  title: string;
  done: string;
  parallel?: boolean;
}

export interface Worker {
  task: string;
  role?: string;
  state: "running" | "done";
  output?: string;
}

export interface AgentState {
  status: "idle" | "thinking" | "tool";
  model: string;
  provider: string;
  permissionMode: string;
  toolCount: number;
  tokens: { in: number; out: number; ctx: number };
  activeTool: string | null;
  rounds: number;
  autonomy: { state: string; mode: string; goal: string; step: number; phases: Phase[] };
  fleet: { active: number; round: number };
  workers: Worker[];
  seq: number;
}

export interface StampedEvent {
  seq: number;
  ts: number;
  type: string;
  [k: string]: unknown;
}

/** Aggregator → UI. */
export type ToUiMsg =
  | { t: "agents"; agents: AgentMeta[] }
  | { t: "snapshot"; agentId: string; state: AgentState; events: StampedEvent[] }
  | { t: "event"; agentId: string; event: StampedEvent }
  | { t: "state"; agentId: string; state: AgentState };
