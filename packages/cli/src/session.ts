import {
  Agent,
  type ArtermConfig,
  AutonomyEngine,
  EventBus,
  type PermissionAsker,
  PermissionManager,
  type PermissionMode,
  createContextStrategy,
  saveConfig,
} from "@arterm/core";
import { createProvider } from "@arterm/providers";
import { defaultTools, taskDoneTool } from "@arterm/tools";
import type { Session } from "@arterm/tui";

export interface SessionOptions {
  config: ArtermConfig;
  providerId?: string;
  model?: string;
  yolo?: boolean;
  cwd: string;
}

/** Builds the wired-up session (agent + provider + tools + permissions) for the TUI. */
export function buildSession(opts: SessionOptions): {
  session: Session;
  persist: () => Promise<void>;
} {
  const { config, cwd } = opts;
  const providerId = opts.providerId ?? config.provider;
  const model = opts.model ?? config.model;

  const provider = createProvider(config, providerId);
  const initialMode: PermissionMode = opts.yolo ? "yolo" : (config.mode ?? "ask");
  const permissions = new PermissionManager(config.permissions, initialMode);
  const bus = new EventBus();

  // The TUI installs the real asker; until then deny by default.
  let asker: PermissionAsker = async () => "deny";

  const agent = new Agent({
    provider,
    model,
    tools: defaultTools(),
    permissions,
    ask: (tool, args) => asker(tool, args),
    bus,
    cwd,
    temperature: config.temperature,
    context: createContextStrategy(config),
    contextWindow: config.context?.window,
    compactAtPercent: config.context?.compactAtPercent,
  });

  const autonomy = new AutonomyEngine(agent, bus, taskDoneTool, {
    mode: config.autonomy?.mode ?? "once",
    maxSteps: config.autonomy?.maxSteps,
  });

  const session: Session = {
    agent,
    bus,
    config,
    providerLabel: provider.id,
    toolCount: defaultTools().length,
    yolo: opts.yolo ?? false,
    setAsker(next) {
      asker = next;
    },
    listModels: () => provider.listModels(),
    switchModel(next) {
      agent.setModel(next);
      config.model = next;
    },
    compact: () => agent.compact("manual"),
    permissionMode: initialMode,
    setMode(next) {
      permissions.setMode(next);
      config.mode = next;
    },
    autonomy,
    mcpServers: [],
    plugins: [],
    skills: [],
    getSkillBody: () => undefined,
  };

  const persist = async () => {
    config.provider = providerId;
    config.permissions = permissions.snapshot();
    // Persist auto/plan/ask as the default, but never make yolo sticky.
    const current = permissions.getMode();
    config.mode = current === "yolo" ? "ask" : current;
    await saveConfig(config);
  };

  return { session, persist };
}
