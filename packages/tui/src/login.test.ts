import { defaultConfig } from "@arterm/core";
import { render } from "ink-testing-library";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { App } from "./App.js";
import type { LoginProvider, Session } from "./types.js";

// Raw stdin byte sequences ink parses into key events.
const ENTER = "\r";
const DOWN = `${String.fromCharCode(27)}[B`; // ESC[B — down arrow

/** Let React flush the state update + ink re-subscribe the useInput handler
 *  before the next keystroke, so each write hits the updated `loginStep`. */
const tick = (ms = 25): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The four backends the overlay drives through, in providerCatalog order. */
const LOGIN_PROVIDERS: LoginProvider[] = [
  { id: "ollama", label: "Ollama — local server", needsKey: false },
  { id: "llamacpp", label: "llama.cpp — local .gguf", needsKey: false },
  {
    id: "openai-compat",
    label: "OpenAI-compatible — custom host",
    needsKey: false,
    needsHost: true,
  },
  { id: "anthropic", label: "Anthropic — Claude", needsKey: true, supportsOAuth: true },
];

/** A Session mock complete enough to mount <App> and drive the /login overlay.
 *  Only the members the login flow touches carry real behavior; the rest are
 *  inert stubs so the component renders. */
function makeSession(): Session {
  const config = { ...defaultConfig(), openaiCompatHost: "" };
  const noop = (): void => {};
  return {
    agent: {
      model: "qwen2.5:7b",
      effectiveContextWindow: () => 8192,
      reset: noop,
      run: async () => {},
    },
    bus: { on: () => () => {} },
    config,
    providerLabel: "ollama",
    toolCount: 7,
    yolo: false,
    setAsker: noop,
    listModels: async () => [],
    listAllModels: async () => [],
    switchModel: vi.fn(),
    switchProvider: vi.fn(),
    setApiKey: vi.fn(),
    configureOpenAICompat: vi.fn(async () => {}),
    removeApiKey: vi.fn(),
    signedInProviders: () => [],
    loginProviders: LOGIN_PROVIDERS,
    compact: async () => ({}) as never,
    permissionMode: "auto",
    setMode: noop,
    persistNow: vi.fn(async () => {}),
    startOAuth: vi.fn(async () => "https://claude.ai/oauth/authorize?x=1"),
    completeOAuth: vi.fn(async () => {}),
    autonomy: {
      state: "idle",
      start: async () => {},
      pause: noop,
      resume: noop,
      stop: noop,
      steer: noop,
      setMode: () => true,
    },
    sdd: { state: "idle", run: async () => {}, pause: noop, resume: noop, stop: noop },
    mcpServers: [],
    plugins: [],
    skills: [],
    getSkillBody: () => undefined,
  } as unknown as Session;
}

describe("/login overlay flow", () => {
  it("openai-compat: provider → host → key persists via configureOpenAICompat", async () => {
    const session = makeSession();
    const { stdin, unmount } = render(createElement(App, { session }));
    await tick();

    // Open the overlay with the /login slash command.
    stdin.write("/login");
    await tick();
    stdin.write(ENTER);
    await tick();

    // Move from ollama (0) down to openai-compat (2) and select it → host step.
    stdin.write(DOWN);
    await tick();
    stdin.write(DOWN);
    await tick();
    stdin.write(ENTER);
    await tick();

    // Type the base URL, Enter → key step, type the key, Enter → finish.
    stdin.write("https://agentrouter.org/v1");
    await tick();
    stdin.write(ENTER);
    await tick();
    stdin.write("sk-test-123");
    await tick();
    stdin.write(ENTER);
    await tick();

    expect(session.configureOpenAICompat).toHaveBeenCalledTimes(1);
    expect(session.configureOpenAICompat).toHaveBeenCalledWith({
      host: "https://agentrouter.org/v1",
      key: "sk-test-123",
    });
    unmount();
  });

  it("openai-compat: an empty key is allowed (local hosts need none)", async () => {
    const session = makeSession();
    const { stdin, unmount } = render(createElement(App, { session }));
    await tick();

    stdin.write("/login");
    await tick();
    stdin.write(ENTER);
    await tick();
    stdin.write(DOWN);
    await tick();
    stdin.write(DOWN);
    await tick();
    stdin.write(ENTER);
    await tick();
    stdin.write("http://localhost:1234/v1");
    await tick();
    stdin.write(ENTER);
    await tick();
    // No key typed — Enter straight through the key step.
    stdin.write(ENTER);
    await tick();

    expect(session.configureOpenAICompat).toHaveBeenCalledWith({
      host: "http://localhost:1234/v1",
      key: undefined,
    });
    unmount();
  });

  it("anthropic: `o` starts OAuth, pasted code#state completes it", async () => {
    const session = makeSession();
    const { stdin, unmount } = render(createElement(App, { session }));
    await tick();

    stdin.write("/login");
    await tick();
    stdin.write(ENTER);
    await tick();

    // Move down to anthropic (index 3).
    stdin.write(DOWN);
    await tick();
    stdin.write(DOWN);
    await tick();
    stdin.write(DOWN);
    await tick();

    // `o` opens the subscription (OAuth) step and spawns the authorize URL.
    stdin.write("o");
    await tick();
    expect(session.startOAuth).toHaveBeenCalledWith("anthropic");

    // Paste the callback `code#state` and submit.
    stdin.write("code123#state456");
    await tick();
    stdin.write(ENTER);
    await tick();

    expect(session.completeOAuth).toHaveBeenCalledWith("anthropic", "code123#state456");
    unmount();
  });
});
