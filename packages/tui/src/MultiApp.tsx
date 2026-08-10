import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { App } from "./App.js";
import { SessionPanel, type SessionPanelEntry } from "./SessionPanel.js";
import { Box, useApp, useInput, useStdout } from "./ink.js";
import { SessionMeta } from "./sessionMeta.js";
import type { Session } from "./types.js";

interface Entry {
  id: string;
  session: Session;
  meta: SessionMeta;
  initialPrompt?: string;
}

/** First user prompt of a session — the panel's row title. */
function sessionTitle(entry: Entry): string {
  const first = entry.session.agent.history.find((m) => m.role === "user");
  return first?.content ?? entry.initialPrompt ?? "yeni oturum";
}

function recentPrompts(entry: Entry): string[] {
  return entry.session.agent.history
    .filter((m) => m.role === "user")
    .slice(-3)
    .map((m) => m.content);
}

/**
 * Multi-session host: mounts every session's <App> (hidden ones keep running —
 * bus subscriptions, queues and counters all live in the mounted component) and
 * shows exactly one, or the session panel. Also owns the process-global
 * terminal-mode escapes so session switches never flap them.
 */
export function MultiApp({
  initial,
  initialGoal,
  createSession,
  closeSession,
  fullscreen = false,
  version,
}: {
  initial: { id: string; session: Session };
  initialGoal?: string;
  createSession?: () => Promise<{ id: string; session: Session }>;
  closeSession?: (id: string) => Promise<void>;
  fullscreen?: boolean;
  /** CLI version for the status bar (single source: the binary). */
  version?: string;
}): React.ReactElement {
  const [entries, setEntries] = useState<Entry[]>(() => [
    { id: initial.id, session: initial.session, meta: new SessionMeta(initial.session) },
  ]);
  const [activeId, setActiveId] = useState(initial.id);
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelSel, setPanelSel] = useState(0);
  const [panelInput, setPanelInput] = useState("");
  const [creating, setCreating] = useState(false);
  // Sessions whose permission prompt is waiting (fed by each App).
  const [awaiting, setAwaiting] = useState<ReadonlySet<string>>(new Set());
  // Meta changes (background activity) repaint the badge/panel via this tick.
  // The VALUE is consumed below: panelEntries snapshots each meta with .get()
  // inside a useMemo, and a memo that does not depend on the tick re-renders
  // with the STALE snapshot — the panel showed every background session frozen
  // at whatever it was doing when the panel opened.
  const [metaTick, setMetaTick] = useState(0);

  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  // The panel handler reads these through refs, never its own closure: a
  // keypress can arrive before the re-subscription effect that would refresh
  // the closure lands (same rationale as InputLine's valueRef).
  const panelInputRef = useRef(panelInput);
  panelInputRef.current = panelInput;
  const panelSelRef = useRef(panelSel);
  panelSelRef.current = panelSel;

  useEffect(() => {
    const unsubs = entries.map((e) => e.meta.subscribe(() => setMetaTick((t) => t + 1)));
    return () => {
      for (const u of unsubs) u();
    };
  }, [entries]);

  // Dispose metas only on unmount — sessions themselves outlive the TUI.
  useEffect(
    () => () => {
      for (const e of entriesRef.current) e.meta.dispose();
    },
    [],
  );

  // ── Process-global terminal modes (moved out of App so switches don't flap
  // them). Mouse behavior is uniform across sessions: all configs share tui.*.
  const { stdout: rawStdout } = useStdout();
  // /mouse flips capture at runtime (null = follow config): selection needs the
  // capture OFF, the in-app wheel needs it ON, and restarting to switch between
  // "copy this text" and "scroll the chat" is not a real workflow.
  const [mouseOverride, setMouseOverride] = useState<boolean | null>(null);
  // Default OFF: plain left-drag must select text — the single most common
  // mouse gesture — without a modifier or a slash command. The wheel still
  // scrolls via the terminal's alternate-scroll arrows; /mouse (or
  // tui.mouse: true) opts back into deterministic in-app wheel capture.
  const mouseCapture = fullscreen && (mouseOverride ?? initial.session.config.tui?.mouse ?? false);
  const toggleMouse = useCallback((): boolean => {
    const next = !mouseCapture;
    setMouseOverride(next);
    return next;
  }, [mouseCapture]);
  useEffect(() => {
    if (!rawStdout) return;
    const ESC = String.fromCharCode(27);
    // Written on mount AND on every resize: a host terminal can reset the
    // emulator behind our back — the desktop app's renderer pool reset()s a
    // pane on rebind and replays a serialized snapshot that restores ?1000h
    // but not ?1006h, downgrading wheel reports to X10 bytes the SGR parser
    // can't read (dead wheel). Every such rebind ends in a SIGWINCH kick, so
    // re-asserting here heals it; re-sending the modes is idempotent.
    const assertModes = mouseCapture
      ? (): void => {
          rawStdout.write(`${ESC}[?1002l${ESC}[?1003l${ESC}[?1007l${ESC}[?1000h${ESC}[?1006h`);
        }
      : (): void => {
          // Clear any reporting a crashed program left behind; arrows carry the
          // wheel in fullscreen (alternate scroll), nothing in classic.
          rawStdout.write(
            `${ESC}[?1000l${ESC}[?1002l${ESC}[?1003l${ESC}[?1006l${fullscreen ? `${ESC}[?1007h` : ""}`,
          );
        };
    assertModes();
    rawStdout.on("resize", assertModes);
    return () => {
      rawStdout.off("resize", assertModes);
      if (mouseCapture) rawStdout.write(`${ESC}[?1000l${ESC}[?1006l`);
    };
  }, [rawStdout, fullscreen, mouseCapture]);

  // Classic-mode resize recovery: reflowed wrapped lines invalidate Ink's
  // RELATIVE erase counts and the region loses its bottom anchor — blank the
  // screen (2J only, scrollback stays) and re-pad to the new bottom.
  useEffect(() => {
    if (!rawStdout || fullscreen) return;
    const onResize = (): void => {
      const ESC = String.fromCharCode(27);
      rawStdout.write(`${ESC}[2J${ESC}[H${"\n".repeat(Math.max(0, (rawStdout.rows ?? 24) - 1))}`);
    };
    rawStdout.on("resize", onResize);
    return () => {
      rawStdout.off("resize", onResize);
    };
  }, [rawStdout, fullscreen]);

  // Classic mode repaints via <Static>, which reprints the whole transcript on
  // remount — clear first (the /clear recipe) so a switch reads as a redraw.
  const clearForSwitch = useCallback(() => {
    if (fullscreen || !rawStdout) return;
    const ESC = String.fromCharCode(27);
    rawStdout.write(
      `${ESC}[3J${ESC}[2J${ESC}[H${"\n".repeat(Math.max(0, (rawStdout.rows ?? 24) - 1))}`,
    );
  }, [fullscreen, rawStdout]);

  const switchTo = useCallback(
    (id: string) => {
      if (id !== activeIdRef.current) clearForSwitch();
      setActiveId(id);
      setPanelOpen(false);
      setPanelInput("");
    },
    [clearForSwitch],
  );

  const cycle = useCallback(
    (dir: -1 | 1) => {
      const list = entriesRef.current;
      if (list.length < 2) return;
      const idx = list.findIndex((e) => e.id === activeIdRef.current);
      const next = list[(idx + dir + list.length) % list.length];
      if (next) switchTo(next.id);
    },
    [switchTo],
  );

  const openPanel = useCallback(() => {
    const idx = entriesRef.current.findIndex((e) => e.id === activeIdRef.current);
    setPanelSel(Math.max(0, idx));
    setPanelInput("");
    setPanelOpen(true);
  }, []);

  const createFromPanel = useCallback(
    (prompt: string) => {
      if (!createSession || creating) return;
      setCreating(true);
      void (async () => {
        try {
          const made = await createSession();
          const entry: Entry = {
            id: made.id,
            session: made.session,
            meta: new SessionMeta(made.session),
            initialPrompt: prompt || undefined,
          };
          // The new row's index is the length BEFORE the append. Read off the
          // ref AFTER setEntries this was one past the end — the awaits above
          // give React room to flush, so the ref is not reliably stale — and
          // Enter on an out-of-range selection silently did nothing.
          const nextIndex = entriesRef.current.length;
          setEntries((cur) => [...cur, entry]);
          // STAY on the panel — the whole point of typing a task here is a
          // session that works in the BACKGROUND (the initialPrompt submits on
          // mount whether or not the App is visible). Switching on create made
          // the panel a detour; Claude Code's dashboard is the model: the new
          // row appears, its status turns busy, Enter opens it when wanted.
          setPanelInput("");
          setPanelSel(nextIndex);
        } finally {
          setCreating(false);
        }
      })();
    },
    [createSession, creating, switchTo],
  );

  // Ctrl+X: close one session. The last one standing closes the whole app —
  // same as Ctrl+C — so the TUI never renders an empty session list.
  const { exit } = useApp();
  const closeEntry = useCallback(
    (id: string) => {
      const list = entriesRef.current;
      const idx = list.findIndex((e) => e.id === id);
      if (idx < 0) return;
      if (list.length <= 1) {
        exit();
        return;
      }
      const entry = list[idx];
      // If the closed session is on screen, land on its right neighbor (wraps).
      if (id === activeIdRef.current) {
        const next = list[(idx + 1) % list.length];
        if (next && next.id !== id) switchTo(next.id);
      }
      entry?.meta.dispose();
      setEntries((cur) => cur.filter((e) => e.id !== id));
      setAwaiting((cur) => {
        if (!cur.has(id)) return cur;
        const next = new Set(cur);
        next.delete(id);
        return next;
      });
      setPanelSel((s) => Math.min(s, entriesRef.current.length - 2));
      // Resource release (status server, memory digest) runs behind the UI.
      void closeSession?.(id);
    },
    [exit, switchTo, closeSession],
  );

  const onPendingChange = useCallback((id: string, pending: boolean) => {
    setAwaiting((cur) => {
      if (cur.has(id) === pending) return cur;
      const next = new Set(cur);
      if (pending) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  // Panel keys: ↑/↓ select, Enter = create (input typed) or switch, Ctrl+X
  // close selected, Esc close panel.
  useInput(
    (input, key) => {
      if (key.escape) {
        setPanelOpen(false);
        setPanelInput("");
        return;
      }
      if (key.ctrl && (input === "x" || input === "X")) {
        const target = entriesRef.current[panelSelRef.current];
        if (target) closeEntry(target.id);
        return;
      }
      if (key.upArrow) {
        setPanelSel((s) => Math.max(0, s - 1));
        return;
      }
      if (key.downArrow) {
        setPanelSel((s) => Math.min(entriesRef.current.length - 1, s + 1));
        return;
      }
      if (key.return) {
        const typed = panelInputRef.current.trim();
        if (typed && createSession) {
          createFromPanel(typed);
          return;
        }
        const list = entriesRef.current;
        const target = list[Math.min(panelSelRef.current, list.length - 1)];
        if (target) switchTo(target.id);
        return;
      }
      if (key.backspace || key.delete) {
        setPanelInput((s) => s.slice(0, -1));
        return;
      }
      if (input && !key.ctrl && !key.meta && !key.tab) {
        setPanelInput((s) => s + input);
      }
    },
    { isActive: panelOpen },
  );

  const columns = rawStdout?.columns ?? 80;
  const active = entries.find((e) => e.id === activeId) ?? entries[0];
  const busyBackground = entries.filter(
    (e) =>
      e.id !== activeId &&
      (e.meta.get().status !== "idle" || e.meta.get().autonomyRunning || awaiting.has(e.id)),
  ).length;

  const panelEntries = useMemo<SessionPanelEntry[]>(
    () =>
      entries.map((e) => ({
        id: e.id,
        title: sessionTitle(e),
        meta: e.meta.get(),
        recentPrompts: recentPrompts(e),
        awaitingPermission: awaiting.has(e.id),
        goal: e.meta.get().goal,
      })),
    // metaTick is the freshness dependency, not dead weight — see its decl.
    // biome-ignore lint/correctness/useExhaustiveDependencies: metaTick IS the invalidation signal
    [entries, awaiting, metaTick],
  );

  return (
    <>
      {entries.map((e, i) => (
        <App
          key={e.id}
          session={e.session}
          fullscreen={fullscreen}
          visible={!panelOpen && e.id === active?.id}
          initialGoal={e.id === initial.id ? initialGoal : undefined}
          initialPrompt={e.initialPrompt}
          onOpenSessions={openPanel}
          onCycleSession={cycle}
          onCloseSession={() => closeEntry(e.id)}
          onPendingChange={(pending) => onPendingChange(e.id, pending)}
          mouseCapture={mouseCapture}
          // Only meaningful in fullscreen: classic mode captures nothing, so
          // drag already selects and the toggle would be a no-op lie.
          onToggleMouse={fullscreen ? toggleMouse : undefined}
          version={version}
          sessionsBadge={
            entries.length > 1 ? { index: i + 1, count: entries.length, busyBackground } : undefined
          }
        />
      ))}
      {panelOpen ? (
        <Box flexDirection="column" width={columns}>
          <SessionPanel
            entries={panelEntries}
            activeId={active?.id ?? ""}
            selected={panelSel}
            input={panelInput}
            canCreate={Boolean(createSession) && !creating}
            columns={columns}
          />
        </Box>
      ) : null}
    </>
  );
}
