import type {
  Agent,
  ArtermConfig,
  AutonomyEngine,
  CompactionResult,
  EventBus,
  McpServerSummary,
  ModelInfo,
  PermissionAsker,
  PermissionMode,
} from "@arterm/core";

/** Everything the TUI needs from the host (CLI), kept behind one interface. */
export interface Session {
  agent: Agent;
  bus: EventBus;
  config: ArtermConfig;
  providerLabel: string;
  /** Number of tools available to the agent (shown in the status bar). */
  toolCount: number;
  /** True when permission prompts are skipped (--yolo). */
  yolo: boolean;
  /** Wire the permission UI into the agent's permission flow. */
  setAsker(asker: PermissionAsker): void;
  /** List models for the active provider (for /models and the model picker). */
  listModels(): Promise<ModelInfo[]>;
  /** Switch the active model (for /model <name>). */
  switchModel(model: string): void;
  /** Compact the conversation context now (for /compact). */
  compact(): Promise<CompactionResult>;
  /** Current permission mode (ask | auto | plan | yolo). */
  permissionMode: PermissionMode;
  /** Change the permission mode (Shift+Tab / /mode). */
  setMode(mode: PermissionMode): void;
  /** Autonomous goal-loop engine (/goal, /steer, /pause, /resume, /stop). */
  autonomy: AutonomyEngine;
  /** Connected MCP servers (for /mcp); populated after startup. */
  mcpServers: McpServerSummary[];
}

/** A rendered transcript entry. */
export type DisplayItem =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | {
      kind: "tool";
      name: string;
      args?: string;
      output?: string;
      isError?: boolean;
      ms?: number;
      bytes?: number;
      tok?: number;
    }
  | { kind: "system"; text: string }
  | { kind: "stats"; inTok: number; outTok: number; rounds: number; ms: number };
