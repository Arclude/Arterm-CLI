import type { Agent, ArtermConfig, EventBus, ModelInfo, PermissionAsker } from "@arterm/core";

/** Everything the TUI needs from the host (CLI), kept behind one interface. */
export interface Session {
  agent: Agent;
  bus: EventBus;
  config: ArtermConfig;
  providerLabel: string;
  /** Wire the permission UI into the agent's permission flow. */
  setAsker(asker: PermissionAsker): void;
  /** List models for the active provider (for /models). */
  listModels(): Promise<ModelInfo[]>;
  /** Switch the active model (for /model <name>). */
  switchModel(model: string): void;
}

export type DisplayItem =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool"; name: string; text: string; isError?: boolean }
  | { kind: "system"; text: string };
