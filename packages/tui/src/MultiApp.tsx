import {
  type PendingAttachment,
  imagePlaceholder,
  readClipboardImage,
  stillMentioned,
} from "@arterm/core";
import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { App } from "./App.js";
import { SessionPanel, type SessionPanelEntry } from "./SessionPanel.js";
import { deleteBackward, isPaste, stripPaste } from "./editing.js";
import { Box, useApp, useInput, useStdout } from "./ink.js";
import { SessionMeta } from "./sessionMeta.js";
import type { Session } from "./types.js";

interface Entry {
  id: string;
  session: Session;
  meta: SessionMeta;
  initialPrompt?: string;
  /** Images pasted into the panel composer, keyed to tokens in the prompt. */
  initialImages?: PendingAttachment[];
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
  // Clipboard images pasted while the panel is up, waiting for the create.
  // Same contract as the composer's: the [Image #N] token in the TEXT is the
  // truth, and the held list follows it at submit time.
  const [panelImages, setPanelImages] = useState<PendingAttachment[]>([]);
  const panelImagesRef = useRef(panelImages);
  panelImagesRef.current = panelImages;
  // One-line feedback ("clipboard holds no image") — the panel has no
  // transcript to say it in, so it gets its own dim line, cleared on typing.
  const [panelNote, setPanelNote] = useState("");
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
  // capture OFF, the wheel needs it ON, and restarting to switch between "copy
  // this text" and "scroll the chat" is not a real workflow.
  const [mouseOverride, setMouseOverride] = useState<boolean | null>(null);
  // Default ON, in fullscreen only. This is the one channel on which a wheel
  // tick cannot be confused with a keypress, which is the whole requirement;
  // the cost is that plain drag-select becomes Shift+drag.
  const mouseCapture = fullscreen && (mouseOverride ?? initial.session.config.tui?.mouse ?? true);
  const toggleMouse = useCallback((): boolean => {
    const next = !mouseCapture;
    setMouseOverride(next);
    return next;
  }, [mouseCapture]);
  useEffect(() => {
    if (!rawStdout) return;
    const ESC = String.fromCharCode(27);
    // ?1007 is never enabled in either branch, and that is the fix. Alternate
    // scroll answers a wheel tick with ARROW KEYS, which on a one-line-per-tick
    // terminal is byte-identical to an ↑ keypress — so scrolling the chat
    // recalled prompts from history, and a three-line setting moved the view in
    // jumps. Nothing downstream can undo that, because there is nothing to tell
    // apart. What replaces it is SGR reporting (?1000h + ?1006h), where the
    // wheel arrives as ESC[<64;x;yM and no keypress can spell it.
    //
    // ?1002/?1003 stay OFF while capturing: they add drag- and any-motion
    // reporting, which is a packet per mouse move for a feature nothing here
    // reads — and this whole change started as a report of lag.
    //
    // Written on mount AND on every resize: a host terminal can reset the
    // emulator behind our back — the desktop app's renderer pool reset()s a
    // pane on rebind and replays a serialized snapshot that restores ?1000h but
    // not ?1006h, downgrading wheel reports to X10 bytes the SGR parser cannot
    // read (dead wheel). Every such rebind ends in a SIGWINCH kick, so
    // re-asserting here heals it; re-sending the modes is idempotent. Claude
    // Code re-asserts its own set the same way, three times in eight seconds.
    //
    // ?25l rides along in both branches: that same snapshot replay brings the
    // cursor back SHOWN, and a hardware cursor over a UI that draws its own is
    // a second cursor.
    const assertModes = mouseCapture
      ? (): void => {
          rawStdout.write(
            `${ESC}[?25l${ESC}[?1002l${ESC}[?1003l${ESC}[?1007l${ESC}[?1000h${ESC}[?1006h`,
          );
        }
      : (): void => {
          // Capture off means NO mouse handling at all — not a fall back to
          // alternate scroll, which is the mode this exists to avoid. The
          // terminal keeps the wheel: its own scrollback in classic mode, and
          // nothing on the alternate screen, where PgUp/PgDn scroll instead.
          rawStdout.write(
            `${ESC}[?25l${ESC}[?1000l${ESC}[?1002l${ESC}[?1003l${ESC}[?1006l${ESC}[?1007l`,
          );
        };
    assertModes();
    rawStdout.on("resize", assertModes);
    return () => {
      rawStdout.off("resize", assertModes);
      if (mouseCapture) rawStdout.write(`${ESC}[?1000l${ESC}[?1006l`);
    };
  }, [rawStdout, mouseCapture]);

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
          // The text decides which images ride: backspacing a token out of the
          // prompt un-attaches its image, exactly as in the composer.
          const kept = stillMentioned(prompt, panelImagesRef.current);
          const entry: Entry = {
            id: made.id,
            session: made.session,
            meta: new SessionMeta(made.session),
            initialPrompt: prompt || undefined,
            ...(kept.length > 0 ? { initialImages: kept } : {}),
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
          setPanelImages([]);
          setPanelSel(nextIndex);
        } finally {
          setCreating(false);
        }
      })();
    },
    [createSession, creating],
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
      // A DRAG onto the dashboard arrives as a bracketed paste — one chunk
      // whose ESC-framed markers read as `meta`, so the old text branch (gated
      // on !meta) swallowed the whole path and the drop did NOTHING. This is
      // why "attach an image to a new session" looked unsupported: the wiring
      // downstream existed, the first keystroke never landed. Checked before
      // every other branch, because a paste must never trigger chords.
      if (isPaste(input) || (!key.ctrl && !key.meta && input.length > 1)) {
        const text = (isPaste(input) ? stripPaste(input) : input).replace(/\n/g, " ");
        if (text) {
          setPanelNote("");
          setPanelInput((s) => s + text);
        }
        return;
      }
      // Ctrl+V: a clipboard IMAGE becomes a held attachment plus its token in
      // the line — the composer's contract, so the background session's
      // `runPlain` picks it up with the same `stillMentioned` walk.
      if (key.ctrl && (input === "v" || input === "V")) {
        void (async () => {
          const { attachment, error } = await readClipboardImage();
          if (!attachment) {
            setPanelNote(error ?? "panoda görsel yok");
            return;
          }
          const placeholder = imagePlaceholder(panelImagesRef.current.length + 1);
          setPanelImages((held) => [...held, { attachment, placeholder }]);
          setPanelInput((v) => (v.length === 0 || v.endsWith(" ") ? v : `${v} `) + placeholder);
          setPanelNote("");
        })();
        return;
      }
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
        // Token-aware: a trailing [Image #N] goes whole, like the composer's.
        setPanelInput((s) => deleteBackward(s));
        return;
      }
      if (input && !key.ctrl && !key.meta && !key.tab) {
        setPanelNote("");
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

  // biome-ignore lint/correctness/useExhaustiveDependencies: metaTick is the invalidation signal — the memo reads live meta via .get()
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
          initialImages={e.initialImages}
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
        <Box
          flexDirection="column"
          width={columns}
          // Fullscreen: the dashboard OWNS the window, list up top and the
          // composer pinned to the bottom — a floating box over nine-tenths of
          // void read as a broken screen, not as a surface. Classic mode keeps
          // the compact box, because there the transcript below is real.
          {...(fullscreen ? { height: rawStdout?.rows ?? 24 } : {})}
        >
          <SessionPanel
            entries={panelEntries}
            activeId={active?.id ?? ""}
            selected={panelSel}
            input={panelInput}
            canCreate={Boolean(createSession) && !creating}
            columns={columns}
            fill={fullscreen}
            note={panelNote}
          />
        </Box>
      ) : null}
    </>
  );
}
