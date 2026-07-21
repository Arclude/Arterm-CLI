import { EventBus, type Message, defaultConfig } from "@arterm/core";
import { render } from "ink-testing-library";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { MultiApp } from "./MultiApp.js";
import type { Session } from "./types.js";

const ENTER = "\r";
const LEFT = "\x1b[D";
const CTRL_LEFT = "\x1b[1;5D";
const CTRL_RIGHT = "\x1b[1;5C";
const CTRL_X = "\x18";
const ESC = "\x1b";
const tick = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor(view: () => string, pred: (f: string) => boolean, timeout = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (pred(view())) return;
    await tick(20);
  }
  throw new Error(`condition not met within ${timeout}ms; last view:\n${view()}`);
}

/** Echoing fake session (queue.test.tsx pattern) with a real message history. */
function fakeSession(bus: EventBus, label: string): Session {
  const noop = (): void => {};
  const history: Message[] = [];
  return {
    agent: {
      model: "qwen2.5:7b",
      history,
      effectiveContextWindow: () => 8192,
      reset: () => {},
      run: async (text: string) => {
        history.push({ role: "user", content: text });
        bus.emit({ type: "turn_start" });
        await tick(60);
        bus.emit({
          type: "assistant_message",
          message: { role: "assistant", content: `${label}:${text}` },
        });
        bus.emit({ type: "turn_end" });
      },
    },
    bus,
    config: { ...defaultConfig() },
    providerLabel: "ollama",
    toolCount: 7,
    yolo: false,
    setAsker: noop,
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
    permissionMode: "auto",
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

function mountMulti() {
  const busA = new EventBus();
  const sessionA = fakeSession(busA, "A");
  const busB = new EventBus();
  const sessionB = fakeSession(busB, "B");
  let created = 0;
  const closed: string[] = [];
  const instance = render(
    createElement(MultiApp, {
      initial: { id: "sess-a", session: sessionA },
      createSession: async () => {
        created++;
        return { id: "sess-b", session: sessionB };
      },
      closeSession: async (id: string) => {
        closed.push(id);
      },
    }),
  );
  return {
    ...instance,
    seen: () => instance.frames.join("\n"),
    last: () => instance.lastFrame() ?? "",
    busA,
    busB,
    createdCount: () => created,
    closedIds: () => closed,
  };
}

describe("MultiApp (multi-session host)", () => {
  it("← opens the session panel and Esc closes it", async () => {
    const m = mountMulti();
    await tick();
    m.stdin.write(LEFT);
    await waitFor(m.seen, (f) => f.includes("OTURUMLAR"));
    m.stdin.write(ESC);
    await waitFor(m.last, (f) => !f.includes("OTURUMLAR"));
    m.unmount();
  });

  it("typing a prompt in the panel creates a session and runs it as first message", async () => {
    const m = mountMulti();
    await tick();
    m.stdin.write(LEFT);
    await waitFor(m.seen, (f) => f.includes("OTURUMLAR"));
    await tick(); // panel input subscription lands on the next effect flush
    m.stdin.write("merhaba");
    await waitFor(m.seen, (f) => f.includes("merhaba"));
    m.stdin.write(ENTER);
    // The new session becomes active and its initialPrompt runs through the agent.
    await waitFor(m.seen, (f) => f.includes("B:merhaba"));
    expect(m.createdCount()).toBe(1);
    m.unmount();
  });

  it("Ctrl+←/→ cycles sessions; a hidden session keeps accumulating events", async () => {
    const m = mountMulti();
    await tick();
    // Create session B via the panel.
    m.stdin.write(LEFT);
    await waitFor(m.seen, (f) => f.includes("OTURUMLAR"));
    await tick(); // panel input subscription lands on the next effect flush
    m.stdin.write("ikinci");
    await tick();
    m.stdin.write(ENTER);
    await waitFor(m.seen, (f) => f.includes("B:ikinci"));

    // While B is visible, emit a full turn on hidden session A's bus.
    m.busA.emit({ type: "turn_start" });
    m.busA.emit({
      type: "assistant_message",
      message: { role: "assistant", content: "arkaplanda-birikti" },
    });
    m.busA.emit({ type: "turn_end" });
    await tick();
    // Hidden session's output must not have been painted anywhere yet.
    expect(m.seen()).not.toContain("arkaplanda-birikti");

    // Switch back to A: the transcript accumulated while hidden gets painted.
    m.stdin.write(CTRL_LEFT);
    await waitFor(m.seen, (f) => f.includes("arkaplanda-birikti"));

    // And forward to B again: a fresh frame repaints B's transcript.
    const framesBefore = m.frames.length;
    m.stdin.write(CTRL_RIGHT);
    await waitFor(
      () => m.frames.slice(framesBefore).join("\n"),
      (f) => f.includes("B:ikinci"),
    );
    m.unmount();
  });

  it("Ctrl+X closes the active session and lands on its neighbor", async () => {
    const m = mountMulti();
    await tick();
    // Create session B via the panel; B becomes active.
    m.stdin.write(LEFT);
    await waitFor(m.seen, (f) => f.includes("OTURUMLAR"));
    await tick(); // panel input subscription lands on the next effect flush
    m.stdin.write("ikinci");
    await tick();
    m.stdin.write(ENTER);
    await waitFor(m.seen, (f) => f.includes("B:ikinci"));
    await waitFor(m.last, (f) => f.includes("2/2"));

    // Close B: the CLI release hook fires and A is back on screen, badge gone.
    m.stdin.write(CTRL_X);
    await waitFor(
      () => m.closedIds().join(","),
      (f) => f === "sess-b",
    );
    await waitFor(m.last, (f) => !f.includes("2/2"));
    m.unmount();
  });

  it("Ctrl+X on the last session takes the whole-app exit path, not per-session release", async () => {
    const m = mountMulti();
    await tick();
    m.stdin.write(CTRL_X);
    await tick(60);
    // Single session: closeSession must NOT fire — MultiApp calls Ink's exit()
    // instead, and the CLI's closeAll() releases the session after runTui.
    expect(m.closedIds()).toEqual([]);
    m.unmount();
  });

  it("the panel lists sessions with their recent prompts", async () => {
    const m = mountMulti();
    await tick();
    // Run a turn in session A so it has history.
    m.stdin.write("ilk gorev");
    await tick();
    m.stdin.write(ENTER);
    await waitFor(m.seen, (f) => f.includes("A:ilk gorev"));

    m.stdin.write(LEFT);
    await waitFor(m.seen, (f) => f.includes("OTURUMLAR"));
    // Row title is the first user prompt; selected row shows recent prompts.
    await waitFor(m.seen, (f) => f.includes("ilk gorev"));
    m.unmount();
  });

  it("re-asserts SGR mouse modes on resize (heals a host-emulator reset)", async () => {
    const bus = new EventBus();
    const instance = render(
      createElement(MultiApp, {
        initial: { id: "sess-a", session: fakeSession(bus, "A") },
        fullscreen: true,
      }),
    );
    const sgrWrites = (): number => instance.frames.join("").split(`${ESC}[?1006h`).length - 1;
    // Mount writes the capture modes once…
    await waitFor(
      () => String(sgrWrites()),
      (n) => Number(n) >= 1,
    );
    const before = sgrWrites();
    // …and a SIGWINCH (the desktop pool's rebind kick) re-asserts them.
    instance.stdout.emit("resize");
    await waitFor(
      () => String(sgrWrites()),
      (n) => Number(n) > before,
    );
    instance.unmount();
  });
});
