import {
  Agent,
  type ChatChunk,
  type ChatProvider,
  type ChatRequest,
  EventBus,
  type PermissionAsker,
  PermissionManager,
  type PermissionMode,
  type Tool,
} from "@arterm/core";
import type { Session } from "@arterm/tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArtermUserError } from "./errors.js";
import { runHeadless } from "./headless.js";

/**
 * End-to-end headless run: a real Agent + real PermissionManager driven by a
 * scripted provider, exercising the full turn loop (tool dispatch, permission
 * denial, event flow) — unlike headless.test.ts, which fakes the agent.
 */
class ScriptedProvider implements ChatProvider {
  readonly id = "scripted";
  calls = 0;
  constructor(private readonly script: ChatChunk[][] = []) {}
  supportsNativeTools(): boolean {
    return true;
  }
  async listModels() {
    return [];
  }
  async *chat(_req: ChatRequest): AsyncIterable<ChatChunk> {
    const chunks = this.script[this.calls] ?? [{ type: "text", delta: "done" }];
    this.calls += 1;
    for (const chunk of chunks) yield chunk;
    yield { type: "done" };
  }
}

const echoTool: Tool = {
  name: "echo",
  description: "echoes text back",
  permission: "allow",
  parameters: { type: "object", properties: { text: { type: "string" } } },
  async execute(args) {
    return { output: String(args.text ?? "") };
  },
};

const guardedTool: Tool = {
  name: "guarded",
  description: "needs interactive permission",
  permission: "ask",
  parameters: { type: "object", properties: {} },
  async execute() {
    return { output: "ran" };
  },
};

function makeSession(
  provider: ChatProvider,
  tools: Tool[],
  mode: PermissionMode = "auto",
): Session {
  const bus = new EventBus();
  // Same wiring as the CLI session: setAsker swaps the closure the agent calls.
  let asker: PermissionAsker = async () => "allow";
  const agent = new Agent({
    provider,
    model: "scripted-model",
    tools,
    permissions: new PermissionManager({}, mode),
    ask: (tool, args) => asker(tool, args),
    bus,
    cwd: process.cwd(),
  });
  return {
    agent,
    bus,
    permissionMode: mode,
    setAsker(next: PermissionAsker) {
      asker = next;
    },
  } as unknown as Session;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runHeadless e2e (real Agent, scripted provider)", () => {
  it("runs a plain text turn through the real loop", async () => {
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const session = makeSession(
      new ScriptedProvider([[{ type: "text", delta: "hello world" }]]),
      [],
    );
    const result = await runHeadless(session, "hi");
    expect(result.response).toBe("hello world");
    expect(result.toolCalls).toEqual([]);
  });

  it("dispatches a tool call end-to-end and feeds the result back", async () => {
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const provider = new ScriptedProvider([
      [{ type: "tool_call", call: { id: "1", name: "echo", arguments: { text: "ping" } } }],
      [{ type: "text", delta: "final answer" }],
    ]);
    const session = makeSession(provider, [echoTool]);
    const result = await runHeadless(session, "use the tool");
    expect(result.toolCalls).toEqual([{ name: "echo" }]);
    expect(result.response).toContain("final answer");
    // Two model rounds: the tool call, then the answer built on its result.
    expect(provider.calls).toBe(2);
  });

  it("denies a permission-gated tool (fail-closed) and hints on stderr", async () => {
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const provider = new ScriptedProvider([
      [{ type: "tool_call", call: { id: "1", name: "guarded", arguments: {} } }],
      [{ type: "text", delta: "ok" }],
    ]);
    const session = makeSession(provider, [guardedTool], "ask");
    await runHeadless(session, "try it");
    const noted = stderr.mock.calls.some((c) => String(c[0]).includes("blocked"));
    expect(noted).toBe(true);
  });

  it("rejects an empty prompt without touching the provider", async () => {
    const provider = new ScriptedProvider();
    const session = makeSession(provider, []);
    await expect(runHeadless(session, "   ")).rejects.toThrow(ArtermUserError);
    expect(provider.calls).toBe(0);
  });
});
