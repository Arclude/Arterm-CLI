import type { Session } from "@arterm/tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArtermUserError } from "./errors.js";
import { runHeadless } from "./headless.js";

// Minimal stand-ins so the test pulls no workspace runtime deps (the `Session`
// and `TokenUsage` imports in headless.ts are type-only and erased at runtime).
type Listener = (event: { type: string; [k: string]: unknown }) => void;

class FakeBus {
  private readonly listeners = new Set<Listener>();
  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(event: { type: string; [k: string]: unknown }): void {
    for (const listener of this.listeners) listener(event);
  }
}

/** Build a fake Session whose agent.run drives `script(bus, asker)`. */
function makeSession(
  script: (
    bus: FakeBus,
    getAsker: () => ((...a: unknown[]) => Promise<string>) | undefined,
  ) => void,
  permissionMode = "ask",
): Session {
  const bus = new FakeBus();
  let asker: ((...a: unknown[]) => Promise<string>) | undefined;
  const session = {
    bus,
    permissionMode,
    setAsker: (a: (...args: unknown[]) => Promise<string>) => {
      asker = a;
    },
    agent: {
      run: async () => {
        await script(bus, () => asker);
      },
    },
  };
  return session as unknown as Session;
}

const restores: Array<() => void> = [];

function captureIo() {
  let out = "";
  let err = "";
  const sink = (target: NodeJS.WriteStream, append: (s: string) => void) => {
    const spy = vi.spyOn(target, "write").mockImplementation(((chunk: unknown) => {
      append(String(chunk));
      return true;
    }) as never);
    restores.push(() => spy.mockRestore());
  };
  sink(process.stdout, (s) => {
    out += s;
  });
  sink(process.stderr, (s) => {
    err += s;
  });
  return {
    out: () => out,
    err: () => err,
  };
}

afterEach(() => {
  for (const restore of restores.splice(0)) restore();
});

describe("runHeadless", () => {
  it("streams plain text to stdout and returns the response", async () => {
    const io = captureIo();
    const session = makeSession((bus) => {
      bus.emit({ type: "text_delta", delta: "Hello" });
      bus.emit({ type: "text_delta", delta: " world" });
      bus.emit({ type: "usage", usage: { totalTokens: 7 } });
    });

    const result = await runHeadless(session, "hi");

    expect(result.response).toBe("Hello world");
    expect(result.usage).toEqual({ totalTokens: 7 });
    expect(io.out()).toContain("Hello world");
  });

  it("emits a single JSON object in --json mode and does not stream deltas", async () => {
    const io = captureIo();
    const session = makeSession((bus) => {
      bus.emit({ type: "text_delta", delta: "answer" });
      bus.emit({ type: "tool_call", call: { id: "1", name: "read", arguments: {} } });
    });

    const result = await runHeadless(session, "hi", { json: true });

    const printed = JSON.parse(io.out());
    expect(printed.response).toBe("answer");
    expect(printed.toolCalls).toEqual([{ name: "read" }]);
    expect(result.toolCalls).toEqual([{ name: "read" }]);
  });

  it("records tool calls", async () => {
    captureIo();
    const session = makeSession((bus) => {
      bus.emit({ type: "tool_call", call: { id: "1", name: "bash", arguments: {} } });
      bus.emit({ type: "tool_call", call: { id: "2", name: "write", arguments: {} } });
    });

    const result = await runHeadless(session, "hi");
    expect(result.toolCalls.map((t) => t.name)).toEqual(["bash", "write"]);
  });

  it("throws ArtermUserError when the run reports an error event", async () => {
    captureIo();
    const session = makeSession((bus) => {
      bus.emit({ type: "error", error: "model exploded" });
    });
    await expect(runHeadless(session, "hi")).rejects.toThrow(ArtermUserError);
  });

  it("rejects an empty prompt", async () => {
    captureIo();
    const session = makeSession(() => {});
    await expect(runHeadless(session, "   ")).rejects.toThrow(ArtermUserError);
  });

  it("warns on stderr when a tool is blocked outside yolo mode", async () => {
    const io = captureIo();
    const session = makeSession(async (_bus, getAsker) => {
      const ask = getAsker();
      await ask?.();
    }, "ask");

    await runHeadless(session, "hi");
    expect(io.err()).toContain("blocked");
    expect(io.err()).toContain("--yolo");
  });

  it("does not warn about blocked tools in yolo mode", async () => {
    const io = captureIo();
    const session = makeSession(async (_bus, getAsker) => {
      const ask = getAsker();
      await ask?.();
    }, "yolo");

    await runHeadless(session, "hi");
    expect(io.err()).not.toContain("blocked");
  });
});
