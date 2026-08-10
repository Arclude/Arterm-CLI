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
    // The session starts working IN THE BACKGROUND: its initialPrompt reaches
    // the agent while the dashboard stays up — that is the whole point of
    // typing a task here instead of opening a fresh session first.
    await waitFor(m.seen, (f) => f.includes("B:merhaba"));
    expect(m.last()).toContain("OTURUMLAR");
    expect(m.createdCount()).toBe(1);
    // The new row is preselected; Enter opens it.
    m.stdin.write(ENTER);
    await waitFor(m.last, (f) => !f.includes("OTURUMLAR"));
    m.unmount();
  });

  it("a DRAG onto the dashboard (bracketed paste) lands in the composer", async () => {
    // The drop used to do nothing: the ESC-framed paste markers read as meta,
    // and the text branch was gated on !meta — so the whole path was swallowed
    // and "attach an image to a new session" looked unsupported while every
    // wire below it worked.
    const m = mountMulti();
    await tick();
    m.stdin.write(LEFT);
    await waitFor(m.seen, (f) => f.includes("OTURUMLAR"));
    await tick();
    const ESC2 = String.fromCharCode(27);
    m.stdin.write(`${ESC2}[200~/tmp/kanit.png${ESC2}[201~`);
    await waitFor(m.seen, (f) => f.includes("/tmp/kanit.png"));
    // Still the panel, still one session: nothing was created or switched.
    expect(m.last()).toContain("OTURUMLAR");
    expect(m.createdCount()).toBe(0);
    m.unmount();
  });

  it("the dashboard counts its buckets", async () => {
    const m = mountMulti();
    await tick();
    m.stdin.write(LEFT);
    await waitFor(m.seen, (f) => f.includes("OTURUMLAR"));
    // One fresh session, nothing running: the counts line says exactly that.
    await waitFor(m.seen, (f) => f.includes("0 onay bekliyor · 0 çalışıyor · 0 tamamlandı"));
    expect(m.last()).toContain("1 yeni");
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
    // Creation no longer switches — open the preselected new row explicitly.
    m.stdin.write(ENTER);
    await waitFor(m.last, (f) => !f.includes("OTURUMLAR"));

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
    // Creation no longer switches — open the preselected new row explicitly.
    m.stdin.write(ENTER);
    // The badge can only render inside a VISIBLE App with two sessions, so its
    // appearance IS the switch — and scanning `seen` sidesteps lastFrame being
    // a bare control-sequence write (clearForSwitch emits those as frames).
    await waitFor(m.seen, (f) => f.includes("2/2"));

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

  it("starts uncaptured (drag selects), /mouse captures the wheel, /mouse again releases", async () => {
    const bus = new EventBus();
    const instance = render(
      createElement(MultiApp, {
        initial: { id: "sess-a", session: fakeSession(bus, "A") },
        fullscreen: true,
      }),
    );
    const out = () => instance.frames.join("");
    const seen = () => instance.frames.join("\n");
    // Default: NO capture — plain left-drag select works from the first frame;
    // the wheel rides the terminal's alternate-scroll arrows (?1007h).
    await waitFor(out, (f) => f.includes(`${ESC}[?1007h`));
    expect(out()).not.toContain(`${ESC}[?1006h`);

    instance.stdin.write("/mouse");
    await waitFor(seen, (f) => f.includes("/mouse"));
    instance.stdin.write(ENTER);
    // Opt IN: capture on the wire (?1006h) and announced.
    await waitFor(seen, (f) => f.includes("mouse capture ON"));
    await waitFor(out, (f) => f.includes(`${ESC}[?1006h`));

    instance.stdin.write("/mouse");
    await tick();
    instance.stdin.write(ENTER);
    // And back out: released (?1006l) with alternate scroll restored.
    await waitFor(seen, (f) => f.includes("mouse capture OFF"));
    await waitFor(out, (f) => f.includes(`${ESC}[?1006l`));
    instance.unmount();
  });

  it("hides the hardware cursor with the mode asserts, and re-hides on resize", async () => {
    // The composer draws its own cursor (\u2758-style bar), so the REAL one is
    // always a second cursor parked wherever the last write ended — observed
    // below the session panel. It rides assertModes for the healing the mouse
    // modes already get: the host pool's snapshot replay restores ?25h.
    const bus = new EventBus();
    const session = fakeSession(bus, "A");
    session.config.tui = { fullscreen: true, mouse: false };
    const instance = render(
      createElement(MultiApp, { initial: { id: "sess-a", session }, fullscreen: true }),
    );
    const hides = (): number => instance.frames.join("").split(`${ESC}[?25l`).length - 1;
    await waitFor(
      () => String(hides()),
      (n) => Number(n) >= 1,
    );
    const before = hides();
    instance.stdout.emit("resize");
    await waitFor(
      () => String(hides()),
      (n) => Number(n) > before,
    );
    instance.unmount();
  });

  it("re-asserts SGR mouse modes on resize (heals a host-emulator reset)", async () => {
    const bus = new EventBus();
    // The rebind-heal scenario is about CAPTURE mode (?1006h downgraded to X10
    // by a pool restore) — so this test opts into capture explicitly.
    const session = fakeSession(bus, "A");
    session.config.tui = { fullscreen: true, mouse: true };
    const instance = render(
      createElement(MultiApp, {
        initial: { id: "sess-a", session },
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
