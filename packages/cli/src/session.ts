import {
  Agent,
  type ArtermConfig,
  EventBus,
  type PermissionAsker,
  PermissionManager,
  saveConfig,
} from "@arterm/core";
import { createProvider } from "@arterm/providers";
import { defaultTools } from "@arterm/tools";
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
  const permissions = new PermissionManager(config.permissions, opts.yolo);
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
  });

  const session: Session = {
    agent,
    bus,
    config,
    providerLabel: provider.id,
    setAsker(next) {
      asker = next;
    },
    listModels: () => provider.listModels(),
    switchModel(next) {
      agent.setModel(next);
      config.model = next;
    },
  };

  const persist = async () => {
    config.provider = providerId;
    config.permissions = permissions.snapshot();
    await saveConfig(config);
  };

  return { session, persist };
}
