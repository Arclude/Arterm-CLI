import { EventBus, PermissionBroker, type Tool, defaultConfig } from "@arterm/core";
import { render } from "ink-testing-library";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { App } from "./App.js";
import type { Session } from "./types.js";

const tick = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor(view: () => string, pred: (f: string) => boolean, timeout = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (pred(view())) return;
    await tick(20);
  }
  throw new Error(`condition not met within ${timeout}ms; last view:\n${view()}`);
}

function fakeSession(bus: EventBus, permissionBroker: PermissionBroker): Session {
  const noop = (): void => {};
  return {
    agent: {
      model: "qwen2.5:7b",
      effectiveContextWindow: () => 8192,
      reset: noop,
      run: async () => {},
    },
    bus,
    config: { ...defaultConfig() },
    providerLabel: "ollama",
    toolCount: 7,
    yolo: false,
    setAsker: (asker: Parameters<PermissionBroker["setAsker"]>[0]) =>
      permissionBroker.setAsker(asker),
    permissionBroker,
    listModels: async () => [],
    listAllModels: async () => [],
    switchModel: noop,
    switchProvider: noop,
    setApiKey: noop,
    configureOpenAICompat: async () => {},
    removeApiKey: noop,
    signedInProviders: () => [],
    loginProviders: [],
    compact: async () => ({}) as never,
    permissionMode: "ask",
    setMode: noop,
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

const writeTool = {
  name: "write_file",
  description: "writes a file",
  parameters: { type: "object" },
  permission: "ask",
  category: "edit",
  preview: (args: Record<string, unknown>) => `write ${String(args.path)}`,
  execute: async () => ({ output: "" }),
} as unknown as Tool;

describe("remote permission answering (desktop ↔ TUI)", () => {
  it("dismisses the TUI prompt when the desktop answers first", async () => {
    const bus = new EventBus();
    const broker = new PermissionBroker(bus);
    const { frames, unmount } = render(createElement(App, { session: fakeSession(bus, broker) }));
    // The LAST write is not always a UI frame: InputLine's unmount cleanup
    // emits the bracketed-paste-off escape as its own stdout frame. Search
    // backwards for a real frame instead (same trick as fallbackBar.test).
    const seen = () => [...frames].reverse().find((f) => f.includes("ARTERM")) ?? "";
    await tick();

    const answered = broker.ask(writeTool, { path: "a.ts" });
    await waitFor(seen, (f) => f.includes("Permission required") && f.includes("write a.ts"));

    // The desktop answers over the status server while the prompt is still up.
    const id = broker.current()?.id ?? "";
    expect(broker.answer(id, "allow")).toEqual({ ok: true });
    await expect(answered).resolves.toBe("allow");

    // The prompt must clear itself — a stale prompt would swallow the next keypress.
    await waitFor(seen, (f) => !f.includes("Permission required"));
    expect(broker.current()).toBeNull();

    unmount();
  });

  it("still resolves locally, and a remote answer afterwards is rejected", async () => {
    const bus = new EventBus();
    const broker = new PermissionBroker(bus);
    const { stdin, frames, unmount } = render(
      createElement(App, { session: fakeSession(bus, broker) }),
    );
    // The LAST write is not always a UI frame: InputLine's unmount cleanup
    // emits the bracketed-paste-off escape as its own stdout frame. Search
    // backwards for a real frame instead (same trick as fallbackBar.test).
    const seen = () => [...frames].reverse().find((f) => f.includes("ARTERM")) ?? "";
    await tick();

    const answered = broker.ask(writeTool, { path: "a.ts" });
    await waitFor(seen, (f) => f.includes("Permission required"));
    const id = broker.current()?.id ?? "";

    // One settle tick between "the prompt is painted" and the keypress: the
    // frame string lands at commit time, but PermissionPrompt's useInput
    // subscribes in the post-commit effect — a keypress inside that gap has no
    // subscriber and is dropped. A human is always slower than an effect; the
    // 20ms poll above is not.
    await tick();
    stdin.write("n"); // deny, in the terminal
    await expect(answered).resolves.toBe("deny");

    expect(broker.answer(id, "allow")).toMatchObject({ ok: false });
    await waitFor(seen, (f) => !f.includes("Permission required"));

    unmount();
  });

  it("names the sub-agent that raised the prompt and counts what waits behind it", async () => {
    const bus = new EventBus();
    const broker = new PermissionBroker(bus);
    const { frames, unmount } = render(createElement(App, { session: fakeSession(bus, broker) }));
    // The LAST write is not always a UI frame: InputLine's unmount cleanup
    // emits the bracketed-paste-off escape as its own stdout frame. Search
    // backwards for a real frame instead (same trick as fallbackBar.test).
    const seen = () => [...frames].reverse().find((f) => f.includes("ARTERM")) ?? "";
    await tick();

    // A fan-out is live on the board, then two of its workers ask at once.
    bus.emit({
      type: "fleet_start",
      count: 2,
      tasks: [
        { id: "f1-1", task: "read tools", role: "explorer" },
        { id: "f1-2", task: "read providers", role: "explorer" },
      ],
    });
    await waitFor(seen, (f) => f.includes("read tools"));
    // Both go RUNNING first, exactly as the fleet runner's onStart does.
    for (const id of ["f1-1", "f1-2"]) {
      bus.emit({ type: "team_member_state", id, name: "explorer", state: "running" });
    }
    await waitFor(seen, (f) => f.includes("\u25cf LIVE"));

    const first = broker.askFor({ id: "f1-1", name: "explorer" })(writeTool, { path: "a.ts" });
    broker.askFor({ id: "f1-2", name: "explorer" })(writeTool, { path: "b.ts" });

    // The prompt says WHICH worker is blocked, and how many are behind it.
    await waitFor(seen, (f) => f.includes("Permission required") && f.includes("⚑ explorer"));
    await waitFor(seen, (f) => f.includes("+1 queued"));
    // Its board row says so too, instead of sitting on its last tool call.
    expect(seen()).toContain("⊙ awaiting permission");

    // Answering the first promotes the second: the counter drops to zero and the
    // bar stays up for the new request.
    broker.answer(broker.current()?.id ?? "", "allow");
    await expect(first).resolves.toBe("allow");
    await waitFor(seen, (f) => !f.includes("+1 queued"));
    expect(seen()).toContain("Permission required");
    // The answered row is handed back to its tool instead of reading as blocked.
    await waitFor(seen, (f) => f.includes("\u2699 write_file"));

    unmount();
  });

  it("records a remotely-answered prompt in the transcript", async () => {
    const bus = new EventBus();
    const broker = new PermissionBroker(bus);
    const { frames, unmount } = render(createElement(App, { session: fakeSession(bus, broker) }));
    // The LAST write is not always a UI frame: InputLine's unmount cleanup
    // emits the bracketed-paste-off escape as its own stdout frame. Search
    // backwards for a real frame instead (same trick as fallbackBar.test).
    const seen = () => [...frames].reverse().find((f) => f.includes("ARTERM")) ?? "";
    await tick();

    const answered = broker.ask(writeTool, { path: "a.ts" });
    await waitFor(seen, (f) => f.includes("Permission required"));
    broker.answer(broker.current()?.id ?? "", "allow_always");
    await expect(answered).resolves.toBe("allow_always");

    // Otherwise the prompt vanishing with no keypress of yours reads as a glitch.
    await waitFor(seen, (f) => f.includes("write_file: always allowed from the desktop"));

    unmount();
  });
});
