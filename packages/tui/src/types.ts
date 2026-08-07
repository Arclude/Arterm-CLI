import type {
  Agent,
  AgentDefSummary,
  ArtermConfig,
  AutonomyEngine,
  BudgetState,
  Checkpoint,
  CompactionResult,
  DiffRow,
  EventBus,
  ExtensionsCheck,
  ExtensionsReload,
  McpServerSummary,
  ModelInfo,
  PermissionAsker,
  PermissionBroker,
  PermissionMode,
  PluginSummary,
  ProcessRegistry,
  RateLimitSnapshot,
  RestoreResult,
  SddRunner,
  SkillInfo,
} from "@arterm/core";

/** A backend the user can pick in the login overlay. */
export interface LoginProvider {
  id: string;
  label: string;
  /** True when the provider needs an API key (the overlay then prompts for one). */
  needsKey: boolean;
  /** True when the provider needs a custom base URL (the overlay prompts for a host). */
  needsHost?: boolean;
  /** True when the provider also supports subscription login (OAuth, via `arterm login`). */
  supportsOAuth?: boolean;
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
  /**
   * The broker sitting between the agent and the prompt installed above. The
   * status server reads its pending request into the snapshot and answers it
   * remotely, so a prompt raised in a background terminal tab can be resolved
   * from the desktop GUI (docs/desktop-integration.md §8).
   */
  permissionBroker: PermissionBroker;
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
  /**
   * Configure and activate the openai-compat provider from the TUI /login flow:
   * set the base URL (host), store the optional API key encrypted, apply any
   * gateway-specific headers, switch to it, and persist the config to disk.
   */
  configureOpenAICompat(opts: { host: string; key?: string }): Promise<void>;
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
  /**
   * Background children this session started (see `processRegistry.ts`). `/ps`
   * reads and stops them — the user's half of a feature whose whole risk is
   * leaving something running after the session ends.
   */
  processes: ProcessRegistry;
  /** Change the permission mode (Shift+Tab / /mode). */
  setMode(mode: PermissionMode): void;
  /**
   * Arm (true) / disarm (false) autonomous mode on the live session — the
   * Shift+Tab slot past PLAN: yolo permissions, verify-persist, sub-agent
   * auto-approve, and step auto-extend, flipped at runtime with NO config
   * write, so quitting while armed cannot leak yolo into the saved config.
   * Returns announcement lines to print (empty when the call was a no-op).
   * Injected by the CLI; absent in headless/test sessions.
   */
  setAutonomous?(on: boolean): string[];
  /**
   * The provider's most recent rate-limit report (for /limits), harvested from
   * response headers. Undefined until a reply carried the headers, or when the
   * backend never reports (e.g. Ollama). Injected by the CLI.
   */
  rateLimits?(): RateLimitSnapshot | undefined;
  /**
   * What this run has spent against its budget (for /limits and the headless
   * `guards.budget` block). Absent in sessions the CLI didn't build.
   */
  budgetState?(): BudgetState;
  /**
   * One line naming the execution boundary shell commands run inside, when one
   * is in force. Absent means the host — which `permissionMode` alone cannot
   * distinguish, since yolo looks the same either way.
   */
  sandboxDescription?: string;
  /**
   * Checkpoint / rewind (`/rewind`, `/redo`). Injected by the CLI; absent in
   * headless and test sessions, where the command says so rather than pretending.
   */
  checkpoints?: {
    list(): Promise<Checkpoint[]>;
    restore(id: string): Promise<RestoreResult>;
    redoTarget(): string | undefined;
  };
  /**
   * Persist the current provider/model/mode to ~/.arterm/config.json right away
   * (normally that happens only on clean exit). Injected by the CLI; absent in
   * tests. Lets a TUI model/login choice survive a crash and become the default.
   */
  persistNow?(): Promise<void>;
  /**
   * Subscription (OAuth/PKCE) login, for providers with `supportsOAuth`. Injected
   * by the CLI. `startOAuth` opens the browser and returns the authorize URL;
   * `completeOAuth` takes the pasted `code#state` callback value, exchanges it,
   * and stores the tokens encrypted.
   */
  startOAuth?(providerId: string): Promise<string>;
  completeOAuth?(providerId: string, pastedCode: string): Promise<void>;
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
  /**
   * Loaded agent definitions (for /agents and the /team roster catalog);
   * populated after startup by the CLI. Absent in headless/test sessions.
   */
  agentDefs?: AgentDefSummary[];
  /** Returns a skill's instruction body to run it (for /skill <name>). */
  getSkillBody(name: string): string | undefined;
  /**
   * Live-probe every MCP server (ping + latency) and validate plugins on disk
   * (for /mcp check and /plugins check). Injected by the CLI; absent in
   * headless/test sessions.
   */
  checkExtensions?(): Promise<ExtensionsCheck>;
  /**
   * Reconnect failed MCP servers and rescan the plugins directory, registering
   * any newly available tools with the agent (for /mcp reload and /plugins
   * reload). Already-registered tools are never replaced or removed — a restart
   * fully applies removals/updates. Injected by the CLI; absent in headless/test
   * sessions.
   */
  reloadExtensions?(): Promise<ExtensionsReload>;
  /**
   * The effective permission table for `/permissions`, already formatted.
   *
   * Injected by the CLI because the policy and the tool list live there. It uses
   * the tools this session actually loaded — so unlike `arterm permissions list`,
   * which re-collects them, the table answers for the agent in front of you,
   * including whatever MCP servers and plugins came up in this run.
   */
  permissionsTable?(opts?: { mode?: PermissionMode; only?: string }): string;
  /**
   * Project-memory legend to show at session start (claude-mem-style), or "" when
   * there's nothing to recall. Rendered once as a system block above the prompt.
   */
  memoryBanner?: string;
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
      /** Rich line-numbered diff from a completed mutating tool (rendered on the result). */
      diffRows?: DiffRow[];
      /** Path a mutating tool changed (shown in the diff header). */
      path?: string;
      output?: string;
      isError?: boolean;
      ms?: number;
      bytes?: number;
      tok?: number;
      /**
       * Images this result sent to the model. The terminal cannot draw them,
       * but their cost has to be visible: an image is the most expensive thing
       * a tool can put in the context and it is re-sent every later turn.
       */
      images?: { count: number; bytes: number };
    }
  /** A status line. `color` overrides the default gray — sub-agent lines use their
   *  worker's accent colour (see agentColor.ts) so a fan-out is readable. */
  | { kind: "system"; text: string; color?: string }
  /** Styled welcome banner shown once at startup. */
  | { kind: "banner"; provider: string; model: string }
  /** Styled command reference, shown on /help or `?`. */
  | { kind: "help" }
  | { kind: "stats"; inTok: number; outTok: number; rounds: number; ms: number };
