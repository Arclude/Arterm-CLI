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
  PluginSummary,
  SddRunner,
  SkillInfo,
} from "@arterm/core";

/** A backend the user can pick in the login overlay. */
export interface LoginProvider {
  id: string;
  label: string;
  /** True when the provider needs an API key (the overlay then prompts for one). */
  needsKey: boolean;
}

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
  /** List models for the active provider. */
  listModels(): Promise<ModelInfo[]>;
  /** List models across all local + signed-in providers (the Alt+P picker). Each
   *  ModelInfo carries its `provider` id so selecting one can switch providers. */
  listAllModels(): Promise<ModelInfo[]>;
  /** Switch the active model (for /model <name>). */
  switchModel(model: string): void;
  /** Switch the active chat provider (for /login). */
  switchProvider(id: string): void;
  /** Store an API key for a provider (encrypted) — used by /login. */
  setApiKey(provider: string, key: string): void;
  /** Forget a provider's stored API key — used by /login (remove). */
  removeApiKey(provider: string): void;
  /** Provider ids the user has stored a key for (shown as ✓ in the login overlay). */
  signedInProviders(): string[];
  /** Backends offered in the login overlay. */
  loginProviders: LoginProvider[];
  /** Compact the conversation context now (for /compact). */
  compact(): Promise<CompactionResult>;
  /** Current permission mode (ask | auto | plan | yolo). */
  permissionMode: PermissionMode;
  /** Change the permission mode (Shift+Tab / /mode). */
  setMode(mode: PermissionMode): void;
  /** Autonomous goal-loop engine (/goal, /steer, /pause, /resume, /stop). */
  autonomy: AutonomyEngine;
  /** Spec-Driven Development runner (/sdd). */
  sdd: SddRunner;
  /** Connected MCP servers (for /mcp); populated after startup. */
  mcpServers: McpServerSummary[];
  /** Loaded plugins (for /plugins); populated after startup. */
  plugins: PluginSummary[];
  /** Available skills (for /skills); populated after startup. */
  skills: SkillInfo[];
  /** Returns a skill's instruction body to run it (for /skill <name>). */
  getSkillBody(name: string): string | undefined;
}

/** A rendered transcript entry. */
export type DisplayItem =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | {
      kind: "tool";
      name: string;
      args?: string;
      /** Pretty diff preview (edit/write/multi_edit), rendered instead of raw args. */
      diff?: string;
      output?: string;
      isError?: boolean;
      ms?: number;
      bytes?: number;
      tok?: number;
    }
  | { kind: "system"; text: string }
  | { kind: "stats"; inTok: number; outTok: number; rounds: number; ms: number };
