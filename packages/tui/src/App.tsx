import {
  type AutonomyMode,
  type McpServerSummary,
  type ModelInfo,
  PERMISSION_MODES,
  type PermissionAsker,
  type PermissionMode,
  type PluginSummary,
  type SddTaskState,
  cachedCatalogSync,
  fetchCatalog,
  findModelById,
  searchCatalog,
  toolCallPreview,
} from "@arterm/core";
import {
  Box,
  type DOMElement,
  Static,
  Text,
  measureElement,
  useApp,
  useInput,
  useStdin,
  useStdout,
} from "ink";
import type React from "react";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { LoginOverlay } from "./LoginOverlay.js";
import { Item } from "./MessageList.js";
import { ModelPicker } from "./ModelPicker.js";
import { type PendingPermission, PermissionPrompt } from "./PermissionPrompt.js";
import { SddBoard, type SddBoardTask } from "./SddBoard.js";
import { SddInterview } from "./SddInterview.js";
import { type Status, StatusBar } from "./StatusBar.js";
import { TeamBoard, type TeamBoardMember } from "./TeamBoard.js";
import { type ArrowDir, createArrowRouter, parseArrowChunk } from "./arrowRouter.js";
import { osc52Sequence } from "./clipboard.js";
import {
  type HistoryNav,
  commandSuggestion,
  emptyHistory,
  historyDown,
  historyPush,
  historyUp,
  reduceInput,
} from "./editing.js";
import { Markdown } from "./markdown.js";
import { appendFeed, formatMemberEvent } from "./teamFeed.js";
import { looksLikeBigTask } from "./teamSuggest.js";
import type { DisplayItem, LoginProvider, Session } from "./types.js";

/** Soft context-window estimate for the status-bar gauge (local models rarely report one). */
const DEFAULT_CTX = 32768;

/** Streamed tokens repaint the live message at most this often (~22 fps). */
const LIVE_FLUSH_MS = 45;

/** Custom single-line input so `?` on an empty line opens help. */
function InputLine({
  active,
  value,
  commands,
  columns,
  onChange,
  onSubmit,
  onHelp,
  onHistoryPrev,
  onHistoryNext,
  externalArrows = false,
}: {
  active: boolean;
  value: string;
  commands: readonly string[];
  columns: number;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
  onHelp: () => void;
  onHistoryPrev: () => void;
  onHistoryNext: () => void;
  /** Fullscreen: ↑/↓ are owned by App's arrow router (wheel vs keyboard). */
  externalArrows?: boolean;
}): React.ReactElement {
  const suggestion = commandSuggestion(value, commands);
  // The input handler reads the CURRENT value through this ref, never its own
  // closure: a handler can fire before the re-subscription effect that would
  // refresh its closure lands (React flushes passive effects after the commit),
  // and acting on a stale value garbles fast typing around submits.
  const valueRef = useRef(value);
  valueRef.current = value;
  const { stdout } = useStdout();
  // Turn on the terminal's bracketed-paste mode while the prompt is active, so a
  // paste arrives wrapped in ESC[200~ … ESC[201~ and reduceInput inserts it
  // literally instead of submitting on an embedded newline.
  useEffect(() => {
    if (!active || !stdout) return;
    const esc = String.fromCharCode(27);
    stdout.write(`${esc}[?2004h`);
    return () => {
      stdout.write(`${esc}[?2004l`);
    };
  }, [active, stdout]);
  useInput(
    (input, key) => {
      const v = valueRef.current;
      // Fullscreen: never double-handle arrows — the arrow router separates
      // wheel-synthesized arrows (scroll) from keyboard ones (history).
      if (externalArrows && (key.upArrow || key.downArrow)) return;
      // Tab completes a slash command to its first match. Shift+Tab is the
      // permission-mode cycle, handled in App — fall through and leave it.
      if (key.tab && !key.shift) {
        const s = commandSuggestion(v, commands);
        if (s) onChange(v + s);
        return;
      }
      const action = reduceInput(v, input, key);
      switch (action.type) {
        case "submit":
          return onSubmit(action.value);
        case "change":
          return onChange(action.value);
        case "help":
          return onHelp();
        case "history_prev":
          return onHistoryPrev();
        case "history_next":
          return onHistoryNext();
        case "noop":
          return;
      }
    },
    { isActive: active },
  );
  // One width-bounded, wrapping <Text>: a long paste flows onto as many lines as
  // it needs and the box grows vertically, instead of overflowing or ghosting.
  return (
    <Box width={columns}>
      <Text wrap="wrap">
        <Text color="cyan" bold>
          {"› "}
        </Text>
        {value}
        <Text color="cyan">▏</Text>
        {suggestion ? (
          <Text color="gray" dimColor>
            {suggestion}
            {"  ⇥ tab"}
          </Text>
        ) : null}
        {value === "" ? <Text color="gray"> message… (type ? for help)</Text> : null}
      </Text>
    </Box>
  );
}

/** Slash commands offered for Tab-completion (mirrors the handleSlash switch). */
const COMMANDS = [
  "help",
  "model",
  "models",
  "login",
  "catalog",
  "clear",
  "copy",
  "goal",
  "autonomy",
  "team",
  "agents",
  "sdd",
  "steer",
  "pause",
  "resume",
  "stop",
  "compact",
  "cost",
  "config",
  "mcp",
  "plugins",
  "skills",
  "skill",
  "mode",
  "auto",
  "plan",
  "ask",
  "yolo",
  "exit",
  "quit",
] as const;

/** Modes cycled by Shift+Tab; yolo is deliberately excluded (set it via /mode yolo). */
const MODE_CYCLE: PermissionMode[] = ["ask", "auto", "plan"];

/** Format MCP server summaries as ✓/✗ status lines (for /mcp and /mcp reload). */
function mcpSummaryLines(servers: McpServerSummary[]): string {
  return servers
    .map((s) =>
      s.status === "connected"
        ? `  ✓ ${s.name} — ${s.toolCount} tool(s)`
        : `  ✗ ${s.name} — failed: ${s.error ?? "unknown"}`,
    )
    .join("\n");
}

/** Format plugin summaries as trust-glyph status lines (for /plugins and /plugins reload). */
function pluginSummaryLines(ps: PluginSummary[]): string {
  return ps
    .map((p) =>
      p.status === "loaded"
        ? `  ${p.trust === "trusted" ? "✓" : "•"} ${p.name} [${p.trust}] — ${p.toolCount} tool(s)${
            p.blocked ? `, ${p.blocked} blocked` : ""
          }`
        : `  ✗ ${p.name} — failed: ${p.error ?? "unknown"}`,
    )
    .join("\n");
}

/** Current terminal size, tracking resize events so the layout fills the screen. */
function useTermSize(): { rows: number; columns: number } {
  const { stdout } = useStdout();
  const [size, setSize] = useState({ rows: stdout?.rows ?? 24, columns: stdout?.columns ?? 80 });
  useEffect(() => {
    if (!stdout) return;
    const onResize = () => setSize({ rows: stdout.rows ?? 24, columns: stdout.columns ?? 80 });
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);
  return size;
}

/**
 * The live, in-progress assistant message, shown in Ink's dynamic bottom region
 * while streaming (the finished message is committed to <Static> and this
 * clears). Only the TAIL is rendered, for two reasons: the dynamic region must
 * stay well under the terminal height — once Ink's frame reaches `stdout.rows`
 * it falls back to clearing and rewriting the WHOLE terminal on every render
 * (the source of visible stutter and scrollback corruption) — and a shorter
 * frame keeps per-token repaints cheap.
 */
const LiveMessage = memo(function LiveMessage({
  text,
  maxRows,
  columns,
}: {
  text: string;
  maxRows: number;
  columns: number;
}): React.ReactElement {
  const lines = text.split("\n");
  const clipped = lines.length > maxRows;
  const tail = clipped ? lines.slice(-maxRows).join("\n") : text;
  return (
    <Box
      width={columns}
      flexDirection="column"
      borderStyle="single"
      borderColor="green"
      borderTop={false}
      borderRight={false}
      borderBottom={false}
      paddingLeft={1}
    >
      <Text color="green" bold>
        ASSISTANT
      </Text>
      {clipped ? (
        <Text color="gray" dimColor>
          … akış devam ediyor (tam metin bitince yukarıda)
        </Text>
      ) : null}
      <Markdown text={tail} />
    </Box>
  );
});

/**
 * Fullscreen mode's managed, in-app scrollable transcript. The alternate screen
 * has no scrollback for the chat to ride, so we window it ourselves with two
 * nested clips (both directions PROVEN in ink 5 — see viewport probe history):
 *
 *   1. a "cutter" box of height (contentRows − scrollOffset) around the natural
 *      content bottom-clips everything newer than the scroll position;
 *   2. the outer viewport (height-bounded + justifyContent:"flex-end") bottom-
 *      aligns the cutter, so its TOP overflow clips for free.
 *
 * Net visible window: content rows [end − viewport .. end − 1], end = total −
 * offset — i.e. real scrollback. (The old `marginBottom={offset}` trick did NOT
 * do this in ink 5: it shrank the visible slice while staying pinned to the
 * newest rows, which read as "scrolling the wrong way" — never use margins to
 * scroll here.)
 *
 * Wrapped in React.memo so keystrokes in the prompt don't re-lay-out the whole
 * transcript — only items/live/viewport/offset changes do.
 */
const Transcript = memo(function Transcript({
  items,
  live,
  viewportRows,
  scrollOffset,
  columns,
  onMeasure,
}: {
  items: DisplayItem[];
  live: string;
  viewportRows: number;
  scrollOffset: number;
  columns: number;
  /** Reports the measured content height (rows) after each layout, so App can clamp
   *  the scroll offset and keep the view anchored as content streams in. */
  onMeasure: (totalLines: number) => void;
}): React.ReactElement {
  const contentRef = useRef<DOMElement>(null);
  const [contentRows, setContentRows] = useState(0);
  const lastReported = useRef(-1);
  // The inner box is never height-constrained, so this measures the NATURAL
  // content height; the cutter/viewport clip outside it and cannot feed back.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure on content change
  useLayoutEffect(() => {
    const node = contentRef.current;
    if (!node) return;
    const { height } = measureElement(node);
    if (height !== lastReported.current) {
      lastReported.current = height;
      setContentRows(height);
      onMeasure(height);
    }
  }, [items, live, columns, onMeasure]);

  const cut =
    contentRows > 0 ? Math.max(1, contentRows - Math.max(0, scrollOffset)) : undefined;
  return (
    <Box
      width={columns}
      height={Math.max(1, viewportRows)}
      overflowY="hidden"
      justifyContent="flex-end"
      flexDirection="column"
    >
      <Box
        height={cut}
        overflowY={cut === undefined ? undefined : "hidden"}
        flexDirection="column"
        flexShrink={0}
      >
        <Box ref={contentRef} flexDirection="column" flexShrink={0}>
          {items.map((item, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: transcript is append-only
            <Item key={i} item={item} />
          ))}
          {live ? (
            <Box
              flexDirection="column"
              borderStyle="single"
              borderColor="green"
              borderTop={false}
              borderRight={false}
              borderBottom={false}
              paddingLeft={1}
            >
              <Text color="green" bold>
                ASSISTANT
              </Text>
              <Markdown text={live} />
            </Box>
          ) : null}
        </Box>
      </Box>
    </Box>
  );
});

/**
 * Keeps the dynamic bottom region GLUED to the terminal's bottom edge.
 *
 * Ink's log-update repaints by erasing the previous frame from its TOP line and
 * writing the new one below — so when the frame SHRINKS (live message committed,
 * queue drained, a board closed) the cursor ends up higher and the leftover rows
 * stay blank: the region becomes top-anchored and the footer "floats" up off the
 * bottom of the window. This wrapper renders the region inside a bottom-justified
 * box whose height never shrinks mid-flight: it grows with the content (capped at
 * rows-2 — a frame reaching stdout.rows trips Ink's clearTerminal path, which
 * wipes scrollback), holds while the content shrinks (the blank padding sits at
 * the TOP, the footer stays put), and snaps back to the content size when
 * `snapKey` changes — static commits/resize, whose rewrite re-anchors the bottom
 * edge anyway. (Same family of trick as gemini-cli's constrained live region.)
 */
function AnchoredRegion({
  rows,
  columns,
  snapKey,
  children,
}: {
  rows: number;
  columns: number;
  /** Changes on static commits / /clear remounts / resize — moments to re-fit. */
  snapKey: string;
  children: React.ReactNode;
}): React.ReactElement {
  const contentRef = useRef<DOMElement>(null);
  const [regionH, setRegionH] = useState(0);
  const snapRef = useRef(snapKey);
  // Content height does not depend on the container height (fixed width, the
  // clip/justify live on the outer box), so measuring here cannot feed back.
  useLayoutEffect(() => {
    const node = contentRef.current;
    if (!node) return;
    const { height } = measureElement(node);
    const cap = Math.max(4, rows - 2);
    const fit = Math.min(Math.max(1, height), cap);
    setRegionH((cur) => {
      if (snapRef.current !== snapKey) {
        snapRef.current = snapKey;
        return fit; // the bottom edge was just re-anchored — follow the content
      }
      return fit > cur ? fit : cur; // grow with content, never shrink mid-flight
    });
  });
  const inner = (
    <Box ref={contentRef} flexDirection="column" flexShrink={0} width={columns}>
      {children}
    </Box>
  );
  // First render (height unknown yet): content-sized, no clipping flash.
  if (regionH === 0) return inner;
  return (
    <Box
      width={columns}
      height={regionH}
      overflowY="hidden"
      flexDirection="column"
      justifyContent="flex-end"
    >
      {inner}
    </Box>
  );
}

export function App({
  session,
  initialGoal,
  fullscreen = false,
}: {
  session: Session;
  initialGoal?: string;
  /** Alternate-screen mode: pinned footer + in-app scroll (see runTui). */
  fullscreen?: boolean;
}): React.ReactElement {
  const { exit } = useApp();
  const { rows, columns } = useTermSize();
  const [items, setItems] = useState<DisplayItem[]>([]);
  const [status, setStatus] = useState<Status>("idle");
  // Fullscreen in-app scrolling: how many lines the view is lifted off the
  // bottom (0 = pinned to newest). Wheel (via alternate-scroll arrows) and
  // PgUp/PgDn drive it; keyboard ↑/↓ stay on prompt history (arrowRouter tells
  // them apart). totalLines/viewportRows are measured to clamp the offset.
  const [scrollOffset, setScrollOffset] = useState(0);
  const [totalLines, setTotalLines] = useState(0);
  const [viewportRows, setViewportRows] = useState(() => Math.max(1, rows - 8));
  const bottomRef = useRef<DOMElement>(null);
  const viewportRef = useRef(viewportRows);
  const prevContentRef = useRef(0);
  const maxOffsetRef = useRef(0);
  // Prompts entered while a turn is running — drained FIFO by the queue effect
  // (see submit/dispatch). Refs mirror the latest state so input handlers and
  // the drain guard never act through a stale closure.
  const [queue, setQueue] = useState<string[]>([]);
  const queueBusyRef = useRef(false);
  const statusRef = useRef<Status>("idle");
  const queueRef = useRef<string[]>([]);
  statusRef.current = status;
  queueRef.current = queue;
  // Points at drainQueue (defined after `dispatch`); the bus subscription below
  // needs it before that definition exists.
  const drainRef = useRef<() => void>(() => {});
  // Finished transcript items render through Ink's <Static> into the terminal's
  // normal scrollback (native wheel/selection — like Claude Code). <Static> only
  // ever appends, so /clear remounts it via this generation key.
  const [staticGen, setStaticGen] = useState(0);
  // Streamed assistant text for the current round, shown live below the committed
  // transcript and cleared once the full message is recorded (assistant_message).
  const [live, setLive] = useState("");
  const [input, setInput] = useState("");
  const [history, setHistory] = useState<HistoryNav>(emptyHistory);
  const [model, setModel] = useState(session.agent.model);
  const [permMode, setPermMode] = useState<PermissionMode>(session.permissionMode);
  const [autoState, setAutoState] = useState<"idle" | "running" | "paused" | "done" | "stopped">(
    "idle",
  );
  const [goalText, setGoalText] = useState("");
  const [autoStep, setAutoStep] = useState(0);
  const [pending, setPending] = useState<PendingPermission | null>(null);
  const [inTok, setInTok] = useState(0);
  const [outTok, setOutTok] = useState(0);
  const [ctxUsed, setCtxUsed] = useState(0);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerModels, setPickerModels] = useState<ModelInfo[]>([]);
  const [pickerIndex, setPickerIndex] = useState(0);
  const [pickerLoading, setPickerLoading] = useState(false);
  const [pickerQuery, setPickerQuery] = useState("");
  const [providerLabel, setProviderLabel] = useState(session.providerLabel);
  const [loginOpen, setLoginOpen] = useState(false);
  const [loginStep, setLoginStep] = useState<"provider" | "host" | "key" | "oauth">("provider");
  const [loginUrl, setLoginUrl] = useState("");
  const [loginIndex, setLoginIndex] = useState(0);
  const [loginSel, setLoginSel] = useState<LoginProvider | null>(null);
  const [loginKey, setLoginKey] = useState("");
  const [loginHost, setLoginHost] = useState("");
  const [signedIn, setSignedIn] = useState<string[]>(() => session.signedInProviders());
  // /sdd interactive interview: the promise from `ask` is held open until the user
  // finishes answering (or presses Esc). `interviewInput` is the answer being typed.
  const [interview, setInterview] = useState<{
    questions: string[];
    answers: string[];
    resolve: (answers: string[]) => void;
  } | null>(null);
  const [interviewInput, setInterviewInput] = useState("");
  // Live /sdd kanban board — seeded from `sdd_graph`, updated per `sdd_task_state`.
  const [sddTasks, setSddTasks] = useState<SddBoardTask[]>([]);
  const [teamMembers, setTeamMembers] = useState<TeamBoardMember[]>([]);
  // Board navigation: ↑/↓ (on an empty prompt) select a member, Enter opens its
  // activity feed, Esc closes it. Feeds are per-member rings of formatted lines.
  const [teamSel, setTeamSel] = useState(0);
  const [teamDetailOpen, setTeamDetailOpen] = useState(false);
  // Ref mirrors for the always-active Esc handlers below — a handler can fire
  // before the effect that would refresh its closure/subscription lands, so
  // gates are read through refs instead of isActive/closures.
  const teamDetailOpenRef = useRef(false);
  teamDetailOpenRef.current = teamDetailOpen;
  const autoStateRef = useRef(autoState);
  autoStateRef.current = autoState;
  const pendingRef = useRef<PendingPermission | null>(null);
  pendingRef.current = pending;
  const [teamFeeds, setTeamFeeds] = useState<Map<string, string[]>>(new Map());
  // A large-looking prompt held for the y/N team-run offer (never a silent switch).
  const [teamSuggest, setTeamSuggest] = useState<string | null>(null);
  const teamSuggestRef = useRef<string | null>(null);
  teamSuggestRef.current = teamSuggest;
  const filteredPickerModels = useMemo(() => {
    const q = pickerQuery.trim().toLowerCase();
    return q ? pickerModels.filter((m) => m.name.toLowerCase().includes(q)) : pickerModels;
  }, [pickerModels, pickerQuery]);

  const abortRef = useRef<AbortController | null>(null);
  const turnStartRef = useRef(0);
  const turnRef = useRef({ inTok: 0, outTok: 0, rounds: 0, changedFiles: new Set<string>() });

  const push = useCallback((item: DisplayItem) => setItems((prev) => [...prev, item]), []);

  // The mouse is NEVER captured (SGR reporting eats click-drag): in the normal
  // buffer the terminal owns the wheel (native scrollback) and drag-to-select,
  // so no scroll plumbing is needed at all. Any mouse reporting left over from
  // a crashed program is switched off defensively so selection can't be broken.
  // Fullscreen wheel input, two flavors (config tui.mouse):
  //  - captured (default): SGR mouse reporting — wheel arrives as ESC[<64/65;x;yM
  //    with the DIRECTION ENCODED IN THE BYTES (64=up, 65=down), immune to the
  //    terminal's alternate-scroll arrow translation quirks. Like Claude Code's
  //    fullscreen renderer; text selection then needs Shift+drag.
  //  - uncaptured: alternate scroll (DECSET 1007) + arrowRouter timing/batching —
  //    plain drag-select keeps working, wheel direction depends on the terminal.
  // Classic mode captures nothing (native scrollback owns the wheel).
  const { stdout: rawStdout } = useStdout();
  const mouseCapture = fullscreen && (session.config.tui?.mouse ?? true);
  useEffect(() => {
    if (!rawStdout) return;
    const ESC = String.fromCharCode(27);
    if (mouseCapture) {
      rawStdout.write(`${ESC}[?1002l${ESC}[?1003l${ESC}[?1007l${ESC}[?1000h${ESC}[?1006h`);
      return () => {
        rawStdout.write(`${ESC}[?1000l${ESC}[?1006l`);
      };
    }
    // Clear any reporting a crashed program left behind; arrows carry the wheel
    // in fullscreen (alternate scroll), nothing in classic.
    rawStdout.write(
      `${ESC}[?1000l${ESC}[?1002l${ESC}[?1003l${ESC}[?1006l${fullscreen ? `${ESC}[?1007h` : ""}`,
    );
    return undefined;
  }, [rawStdout, fullscreen, mouseCapture]);


  // Classic-mode resize recovery: reflowed wrapped lines invalidate Ink's
  // RELATIVE erase counts (its very next repaint can eat into the transcript or
  // leave stale footer fragments) and the region loses its bottom anchor. Blank
  // the SCREEN (2J only — scrollback stays) and re-pad to the new bottom; the
  // repaint that follows the size-state update then erases nothing but blank
  // pad rows and lands anchored again. syncedStdout makes it one atomic frame.
  // (Fullscreen repaints the whole fixed-height frame anyway — no pad wanted.)
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

  // ── Fullscreen scroll machinery ─────────────────────────────────────────────
  // Viewport height = terminal rows − the measured bottom region (input +
  // overlays + goal + status bar). Runs every commit (no deps) so it
  // self-corrects as the bottom region grows/shrinks.
  useLayoutEffect(() => {
    if (!fullscreen || !bottomRef.current) return;
    const { height } = measureElement(bottomRef.current);
    const vp = Math.max(1, rows - 1 - height);
    viewportRef.current = vp;
    setViewportRows((cur) => (cur === vp ? cur : vp));
  });

  // Receives the transcript's measured height. When content grows while the
  // user is scrolled up, bump the offset by the growth so their view stays
  // anchored; when pinned (offset 0) it stays at the bottom.
  const handleMeasure = useCallback((height: number) => {
    const prev = prevContentRef.current;
    if (height === prev) return;
    prevContentRef.current = height;
    setTotalLines(height);
    setScrollOffset((off) => {
      const max = Math.max(0, height - viewportRef.current);
      if (off > 0 && height > prev) return Math.min(max, off + (height - prev));
      return Math.min(off, max);
    });
  }, []);

  // Positive lines lift the view toward OLDER content, negative returns toward
  // the newest — matching the scroll hint.
  const scrollBy = useCallback((lines: number) => {
    setScrollOffset((o) => Math.max(0, Math.min(maxOffsetRef.current, o + lines)));
  }, []);

  // Captured-mouse wheel: SGR reports (button bit 64; low bits 0 = up, 1 = down) —
  // a fast scroll batches several into one chunk, so sum them. reduceInput
  // separately swallows these so they never touch the prompt text. The mapping
  // (up = +3 = toward OLDER lines) matches the scroll hint and was
  // user-validated back in the SGR era (a4c35a8).
  useInput(
    (input) => {
      let delta = 0;
      for (const mm of input.matchAll(/\[<(\d+);\d+;\d+[Mm]/g)) {
        const cb = Number(mm[1]);
        if ((cb & 64) === 0) continue; // not a wheel event
        const low = cb & 3;
        delta += low === 0 ? 3 : low === 1 ? -3 : 0;
      }
      if (delta !== 0) scrollBy(delta);
    },
    { isActive: mouseCapture },
  );

  // Routes ↑/↓ to prompt history (keyboard) or transcript scroll (wheel via
  // alternate scroll) — see arrowRouter.ts for how the two are told apart.
  const arrowHistoryRef = useRef<(dir: ArrowDir) => void>(() => {});
  const overlayOpenRef = useRef(false);
  const arrowRouter = useMemo(
    () =>
      createArrowRouter({
        onHistory: (dir) => arrowHistoryRef.current(dir),
        onScroll: (dir, lines) => scrollBy(dir === "up" ? lines : -lines),
      }),
    [scrollBy],
  );
  useEffect(() => () => arrowRouter.dispose(), [arrowRouter]);

  // Arrows are taken from Ink's RAW input events: its keypress parser collapses
  // a batched multi-arrow wheel chunk into a single upArrow, hiding the count
  // the router needs. Overlays (picker/login/interview) own arrow navigation.
  const { internal_eventEmitter } = useStdin();
  useEffect(() => {
    // Only the uncaptured fallback needs arrow routing — with SGR capture the
    // wheel never becomes arrows, so ↑/↓ are purely keyboard (direct history).
    if (!fullscreen || mouseCapture) return;
    const onRawInput = (chunk: string): void => {
      if (overlayOpenRef.current) return;
      const runs = parseArrowChunk(chunk);
      if (!runs) return;
      for (const run of runs) arrowRouter.feed(run.dir, run.count);
    };
    internal_eventEmitter.on("input", onRawInput);
    return () => {
      internal_eventEmitter.removeListener("input", onRawInput);
    };
  }, [fullscreen, mouseCapture, internal_eventEmitter, arrowRouter]);

  // PgUp/PgDn page the transcript — a timing-free fallback that also works on
  // terminals whose wheel never reaches the app.
  useInput(
    (_input, key) => {
      if (overlayOpenRef.current) return;
      if (!key.pageUp && !key.pageDown) return;
      const page = Math.max(1, viewportRef.current - 1);
      scrollBy(key.pageUp ? page : -page);
    },
    { isActive: fullscreen },
  );

  // Streamed tokens are buffered and flushed to `live` at most every LIVE_FLUSH_MS:
  // a per-token setState makes Ink repaint the dynamic region for every word,
  // which reads as stuttering. `liveBufRef` always holds the full in-progress text.
  const liveBufRef = useRef("");
  const liveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const appendLive = useCallback((delta: string) => {
    liveBufRef.current += delta;
    if (liveTimerRef.current === null) {
      liveTimerRef.current = setTimeout(() => {
        liveTimerRef.current = null;
        setLive(liveBufRef.current);
      }, LIVE_FLUSH_MS);
    }
  }, []);
  const resetLive = useCallback(() => {
    liveBufRef.current = "";
    if (liveTimerRef.current !== null) {
      clearTimeout(liveTimerRef.current);
      liveTimerRef.current = null;
    }
    setLive("");
  }, []);
  useEffect(() => resetLive, [resetLive]);

  // Wire the permission prompt into the agent's permission flow (once).
  useEffect(() => {
    const asker: PermissionAsker = (tool, args) =>
      new Promise((resolve) => {
        setPending({
          tool,
          args,
          resolve: (answer) => {
            setPending(null);
            resolve(answer);
          },
        });
      });
    session.setAsker(asker);
  }, [session]);

  // Welcome banner (once), followed by the project-memory legend when present.
  useEffect(() => {
    push({ kind: "banner", provider: session.providerLabel, model: session.agent.model });
    if (session.memoryBanner) {
      push({ kind: "system", text: session.memoryBanner });
    }
  }, [session, push]);

  // Subscribe to agent events (once).
  useEffect(() => {
    return session.bus.on((event) => {
      switch (event.type) {
        case "turn_start":
          setStatus("thinking");
          statusRef.current = "thinking"; // eager: gates the queue drain instantly
          setScrollOffset(0); // jump to the newest output when a turn begins
          resetLive();
          turnStartRef.current = Date.now();
          turnRef.current = { inTok: 0, outTok: 0, rounds: 0, changedFiles: new Set<string>() };
          break;
        case "text_delta":
          // Accumulate streamed tokens for a throttled live preview; replaced by
          // the committed assistant_message once the round finishes.
          appendLive(event.delta);
          break;
        case "assistant_message": {
          const text = event.message.content.trim();
          if (text) push({ kind: "assistant", text });
          resetLive();
          turnRef.current.rounds += 1;
          break;
        }
        case "tool_call": {
          setStatus("tool");
          // For mutating tools show only a compact header at call time — the rich
          // line-numbered diff is rendered on the result once it's applied.
          const preview = toolCallPreview(event.call.name, event.call.arguments);
          push({
            kind: "tool",
            name: event.call.name,
            args: JSON.stringify(event.call.arguments),
            diff: preview ? (preview.split("\n")[0] ?? undefined) : undefined,
          });
          break;
        }
        case "tool_result":
          push({
            kind: "tool",
            name: event.name,
            output: event.output,
            isError: event.isError,
            diffRows: event.diff,
            path: event.path,
            bytes: event.output.length,
            tok: Math.ceil(event.output.length / 4),
          });
          if (event.path && !event.isError) turnRef.current.changedFiles.add(event.path);
          setStatus("thinking");
          break;
        case "tool_denied":
          push({
            kind: "system",
            text: `✗ denied ${event.name}${event.reason ? ` — ${event.reason}` : ""}`,
          });
          break;
        case "usage":
          if (event.usage.promptTokens) {
            setInTok((t) => t + (event.usage.promptTokens ?? 0));
            setCtxUsed(event.usage.promptTokens);
            turnRef.current.inTok += event.usage.promptTokens;
          }
          if (event.usage.completionTokens) {
            setOutTok((t) => t + (event.usage.completionTokens ?? 0));
            turnRef.current.outTok += event.usage.completionTokens;
          }
          break;
        case "context_compacted":
          push({
            kind: "system",
            text: `✓ context compacted: ${event.before} → ${event.after} messages${
              event.reason === "auto" ? " (auto)" : ""
            }`,
          });
          setCtxUsed(0);
          break;
        case "goal_set":
          setAutoState("running");
          setGoalText(event.goal);
          setAutoStep(0);
          push({ kind: "system", text: `▸ goal locked (${event.mode}): ${event.goal}` });
          break;
        case "autonomy_step":
          setAutoStep(event.step);
          break;
        case "autonomy_reflect":
          if (event.done && event.note) push({ kind: "system", text: `✓ ${event.note}` });
          break;
        case "autonomy_steer":
          push({ kind: "system", text: `↻ steer: ${event.note}` });
          break;
        case "autonomy_paused":
          setAutoState("paused");
          push({ kind: "system", text: "⏸ autonomy paused — /resume to continue" });
          break;
        case "autonomy_resumed":
          setAutoState("running");
          push({ kind: "system", text: "▶ autonomy resumed" });
          break;
        case "autonomy_done":
          setAutoState("idle");
          autoStateRef.current = "idle";
          setGoalText("");
          push({ kind: "system", text: `✓ goal complete: ${event.summary}` });
          drainRef.current();
          break;
        case "autonomy_stopped":
          setAutoState("idle");
          autoStateRef.current = "idle";
          setGoalText("");
          push({ kind: "system", text: `■ autonomy stopped — ${event.reason}` });
          drainRef.current();
          break;
        case "subagent_start":
          push({
            kind: "system",
            text: `⟳ sub-agent${event.role ? ` (${event.role})` : ""}: ${event.task.slice(0, 80)}`,
          });
          break;
        case "subagent_done":
          push({ kind: "system", text: `↩ sub-agent done: ${event.output.slice(0, 120)}` });
          break;
        case "fleet_start":
          push({ kind: "system", text: `⛓ dispatching ${event.count} sub-agents in parallel…` });
          break;
        case "fleet_done":
          push({ kind: "system", text: `⛓ fleet complete (${event.count} done)` });
          break;
        case "autonomy_fleet_round":
          push({
            kind: "system",
            text: `◆ round ${event.round}: dispatching ${event.tasks.length} subtask(s)`,
          });
          break;
        case "autonomy_aggregate":
          push({
            kind: "system",
            text: `◆ round ${event.round} aggregated (${event.count} result(s))`,
          });
          break;
        case "team_plan":
          // Seed the live member board; the transcript keeps a one-line roster record.
          setTeamMembers(
            event.members.map((m) => ({
              id: m.id,
              name: m.name,
              description: m.description,
              adhoc: m.adhoc,
              state: "pending" as const,
            })),
          );
          setTeamSel(0);
          setTeamDetailOpen(false);
          setTeamFeeds(new Map());
          push({
            kind: "system",
            text: `⚑ team: ${event.members
              .map((m) => `${m.name}${m.adhoc ? "*" : ""}`)
              .join(", ")}  (* = ad-hoc)`,
          });
          break;
        case "team_round":
          push({
            kind: "system",
            text: `◆ round ${event.round}: ${event.tasks
              .map((t) => `${t.member} → ${t.task.slice(0, 48)}`)
              .join("  ·  ")}`,
          });
          break;
        case "team_member_state":
          // Update the board in place; the transcript only records terminal states.
          setTeamMembers((prev) =>
            prev.map((m) =>
              m.id === event.id
                ? {
                    ...m,
                    state: event.state,
                    task: event.task ?? m.task,
                    filesChanged: event.filesChanged ?? m.filesChanged,
                    activity: event.state === "running" ? m.activity : undefined,
                  }
                : m,
            ),
          );
          if (event.state === "done" || event.state === "failed") {
            push({
              kind: "system",
              text: `${event.state === "done" ? "✓" : "✗"} ${event.name}${
                event.filesChanged ? ` — ${event.filesChanged} file(s) changed` : ""
              }`,
            });
          }
          break;
        case "team_member_event": {
          // Live activity + the member's drill-down feed — never the transcript.
          const inner = event.event;
          const activity =
            inner.type === "tool_call"
              ? `⚙ ${inner.call.name}`
              : inner.type === "assistant_message"
                ? "✎ writing"
                : inner.type === "tool_denied"
                  ? "⊘ denied"
                  : undefined;
          if (activity) {
            setTeamMembers((prev) => prev.map((m) => (m.id === event.id ? { ...m, activity } : m)));
          }
          const line = formatMemberEvent(inner);
          if (line) {
            setTeamFeeds((prev) => {
              const next = new Map(prev);
              next.set(event.id, appendFeed(prev.get(event.id), line));
              return next;
            });
          }
          break;
        }
        case "team_patch":
          push({
            kind: "system",
            text: event.ok
              ? `⤓ ${event.name}: patch applied (${event.files} file(s))`
              : `⚠ ${event.name}: patch conflict — branch kept (${(event.detail ?? "").slice(0, 120)})`,
          });
          break;
        case "team_done":
          push({
            kind: "system",
            text: `■ team run complete — ${event.done} done, ${event.failed} failed, ${event.rounds} round(s)`,
          });
          break;
        case "fleet_worktree":
          push({ kind: "system", text: `⑃ worktree ${event.branch}` });
          break;
        case "phase_plan":
          push({
            kind: "system",
            text: `▤ plan: ${event.phases.map((p, i) => `${i + 1}. ${p.title}`).join("  ")}`,
          });
          break;
        case "phase_start":
          push({
            kind: "system",
            text: `▸ phase ${event.index + 1}/${event.total}: ${event.title}`,
          });
          break;
        case "phase_done":
          push({ kind: "system", text: `✓ phase ${event.title}: ${event.summary.slice(0, 160)}` });
          break;
        case "sdd_interview":
          // The interactive interview overlay (driven by `askInterview`) renders the
          // questions and logs the finished Q&A, so nothing to push here.
          break;
        case "sdd_spec":
          push({
            kind: "system",
            text: `📄 spec written (${event.taskCount} task(s)): ${event.specPath}`,
          });
          break;
        case "sdd_graph":
          // Seed the live kanban board; the transcript keeps a one-line plan record.
          setSddTasks(
            event.tasks.map((t) => ({
              id: t.id,
              title: t.title,
              dependsOn: t.dependsOn,
              state: t.state,
            })),
          );
          push({
            kind: "system",
            text: `▤ tasks: ${event.tasks
              .map(
                (t) =>
                  `${t.id}${t.dependsOn.length ? `←[${t.dependsOn.join(",")}]` : ""} ${t.title}`,
              )
              .join("  ·  ")}`,
          });
          break;
        case "sdd_task_state":
          // Update the board in place — it is the live view, so no per-state log line.
          setSddTasks((prev) =>
            prev.map((t) => (t.id === event.id ? { ...t, state: event.state } : t)),
          );
          break;
        case "sdd_done":
          push({
            kind: "system",
            text: `■ /sdd complete — ${event.done} done, ${event.failed} failed`,
          });
          break;
        case "error":
          push({ kind: "system", text: `error: ${event.error}` });
          break;
        case "turn_end": {
          setStatus("idle");
          statusRef.current = "idle";
          drainRef.current(); // a queued prompt (if any) starts once this run unwinds
          resetLive();
          const changed = [...turnRef.current.changedFiles];
          if (changed.length > 0) {
            push({
              kind: "system",
              text: `✎ ${changed.length} file(s) changed: ${changed.join(", ")}`,
            });
          }
          push({
            kind: "stats",
            inTok: turnRef.current.inTok,
            outTok: turnRef.current.outTok,
            rounds: turnRef.current.rounds,
            ms: Date.now() - turnStartRef.current,
          });
          break;
        }
      }
    });
  }, [session, push, appendLive, resetLive]);

  // Kick off an autonomous run if launched with --goal (start() guards re-entry).
  useEffect(() => {
    if (initialGoal) void session.autonomy.start(initialGoal);
  }, [initialGoal, session]);

  // Esc pauses an autonomous run, or cancels a manual turn. While a member's
  // drill-down view is open, Esc closes that first (see the hook below).
  // Esc: close the member drill-down if one is open; otherwise pause an
  // autonomous run or cancel a manual turn (dropping the queued prompts —
  // cancelling means "stop", not "start the next one"). Always subscribed and
  // gated through refs: an isActive flip only takes effect after its effect
  // flushes, which can lag the very keypress it should catch.
  useInput(
    (_input, key) => {
      if (!key.escape || pendingRef.current) return;
      if (teamDetailOpenRef.current) {
        setTeamDetailOpen(false);
        return;
      }
      if (autoStateRef.current === "running") {
        session.autonomy.pause();
        return;
      }
      if (statusRef.current !== "idle") {
        abortRef.current?.abort();
        const dropped = queueRef.current.length;
        if (dropped > 0) {
          setQueue([]);
          push({ kind: "system", text: `⏳ dropped ${dropped} queued prompt(s)` });
        }
      }
    },
    { isActive: true },
  );

  const openPicker = useCallback(
    async (onlyProvider?: string) => {
      setPickerOpen(true);
      setPickerLoading(true);
      setPickerQuery("");
      try {
        const all = await session.listAllModels();
        // A just-signed-in provider gets a focused list; fall back to everything
        // if it returned nothing (bad key, empty account) so the picker stays useful.
        const scoped = onlyProvider ? all.filter((m) => m.provider === onlyProvider) : all;
        const models = scoped.length > 0 ? scoped : all;
        setPickerModels(models);
        const cur = models.findIndex(
          (m) => m.name === session.agent.model && m.provider === session.providerLabel,
        );
        setPickerIndex(cur >= 0 ? cur : 0);
      } catch (err) {
        setPickerModels([]);
        setPickerOpen(false);
        push({
          kind: "system",
          text: `✗ model list failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      } finally {
        setPickerLoading(false);
      }
    },
    [session, push],
  );

  const choose = useCallback(
    (name: string) => {
      session.switchModel(name);
      setModel(name);
      void session.persistNow?.();
      push({ kind: "system", text: `✓ model → ${name} (saved as default)` });
    },
    [session, push],
  );

  // Pick a model from the aggregated list: switch provider too when it differs.
  const chooseModel = useCallback(
    (m: ModelInfo) => {
      try {
        if (m.provider && m.provider !== session.providerLabel) {
          session.switchProvider(m.provider);
          setProviderLabel(session.providerLabel);
          setSignedIn(session.signedInProviders());
        }
        session.switchModel(m.name);
        setModel(m.name);
        void session.persistNow?.();
        push({ kind: "system", text: `✓ ${session.providerLabel} / ${m.name} (saved as default)` });
      } catch (err) {
        push({
          kind: "system",
          text: `✗ switch failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    },
    [session, push],
  );

  // Permission mode: cycle with Shift+Tab, set explicitly via /mode (and /auto, /plan…).
  const applyMode = useCallback(
    (next: PermissionMode): void => {
      session.setMode(next);
      setPermMode(next);
      push({ kind: "system", text: `▸ permission mode → ${next.toUpperCase()}` });
    },
    [session, push],
  );

  const openLogin = useCallback(() => {
    setSignedIn(session.signedInProviders());
    setLoginStep("provider");
    setLoginIndex(0);
    setLoginSel(null);
    setLoginKey("");
    setLoginHost("");
    setLoginOpen(true);
  }, [session]);

  // Persist the key (if any), switch the active provider, and sync the status bar.
  const switchTo = useCallback(
    (p: LoginProvider, key?: string) => {
      try {
        if (key) session.setApiKey(p.id, key);
        session.switchProvider(p.id);
        setSignedIn(session.signedInProviders());
        setProviderLabel(session.providerLabel);
        setModel(session.agent.model);
        push({
          kind: "system",
          text: `✓ provider → ${p.id}${key ? " · key saved (encrypted)" : ""} — pick a model:`,
        });
        // Continue the flow visually: key accepted → straight into that
        // provider's model list; the selection is persisted as the default.
        void openPicker(p.id);
      } catch (err) {
        push({
          kind: "system",
          text: `✗ login failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    },
    [session, push, openPicker],
  );

  // openai-compat login: apply the pasted host + optional key, activate the
  // provider, persist to disk, then continue into that host's model list.
  const finishOpenAICompat = useCallback(
    (host: string, apiKey?: string) => {
      setLoginOpen(false);
      const trimmed = host.trim();
      session.configureOpenAICompat({ host: trimmed, key: apiKey }).then(
        () => {
          setSignedIn(session.signedInProviders());
          setProviderLabel(session.providerLabel);
          setModel(session.agent.model);
          push({
            kind: "system",
            text: `✓ provider → openai-compat · ${trimmed}${apiKey ? " · key saved (encrypted)" : ""} — pick a model:`,
          });
          void openPicker("openai-compat");
        },
        (err: unknown) => {
          push({
            kind: "system",
            text: `✗ login failed: ${err instanceof Error ? err.message : String(err)}`,
          });
        },
      );
    },
    [session, push, openPicker],
  );

  // /sdd interview bridge: the SddRunner calls this with the model's clarifying
  // questions and awaits the returned promise, which we resolve once the user has
  // answered them all (or skipped with Esc). Opening the overlay is all we do here;
  // the "interview" useInput below drives it.
  const askInterview = useCallback(
    (questions: string[]): Promise<string[]> =>
      new Promise<string[]>((resolve) => {
        if (questions.length === 0) {
          resolve([]);
          return;
        }
        setInterviewInput("");
        setInterview({ questions, answers: [], resolve });
      }),
    [],
  );

  // Alt+P (or Ctrl+P) opens the model picker.
  useInput(
    (input2, key) => {
      if ((key.meta || key.ctrl) && (input2 === "p" || input2 === "P")) void openPicker();
    },
    { isActive: status === "idle" && !pickerOpen && !loginOpen && !pending && !interview },
  );

  // Shift+Tab cycles the permission mode (ASK → AUTO → PLAN).
  useInput(
    (_input, key) => {
      if (key.tab && key.shift) {
        const i = MODE_CYCLE.indexOf(permMode);
        applyMode(MODE_CYCLE[(i + 1) % MODE_CYCLE.length] ?? "ask");
      }
    },
    { isActive: status === "idle" && !pickerOpen && !loginOpen && !pending && !interview },
  );

  // Picker navigation + type-to-search filtering.
  useInput(
    (input2, key) => {
      const list = filteredPickerModels;
      if (key.upArrow) setPickerIndex((i) => Math.max(0, i - 1));
      else if (key.downArrow) setPickerIndex((i) => Math.min(list.length - 1, i + 1));
      else if (key.return) {
        const m = list[pickerIndex];
        if (m) chooseModel(m);
        setPickerOpen(false);
      } else if (key.escape) {
        setPickerOpen(false);
      } else if (key.backspace || key.delete) {
        setPickerQuery((q) => q.slice(0, -1));
        setPickerIndex(0);
      } else if (input2 && !key.ctrl && !key.meta) {
        setPickerQuery((q) => q + input2);
        setPickerIndex(0);
      }
    },
    { isActive: pickerOpen },
  );

  // Login overlay: navigate providers, then type/paste the API key.
  useInput(
    (input2, key) => {
      if (key.escape) {
        setLoginOpen(false);
        return;
      }
      if (loginStep === "provider") {
        const list = session.loginProviders;
        const p = list[loginIndex];
        if (key.upArrow) setLoginIndex((i) => Math.max(0, i - 1));
        else if (key.downArrow) setLoginIndex((i) => Math.min(list.length - 1, i + 1));
        else if (key.return) {
          if (!p) return;
          if (p.needsHost) {
            // openai-compat: collect the base URL first (prefilled with the
            // current host), then an optional API key.
            setLoginSel(p);
            setLoginHost(session.config.openaiCompatHost ?? "");
            setLoginKey("");
            setLoginStep("host");
          } else if (!p.needsKey || signedIn.includes(p.id)) {
            // No key needed, or already signed in → switch straight away using
            // the stored key. Otherwise collect a key first.
            switchTo(p);
            setLoginOpen(false);
          } else {
            setLoginSel(p);
            setLoginKey("");
            setLoginStep("key");
          }
        } else if (input2 === "r" && p?.needsHost) {
          // Re-enter host + key for openai-compat.
          setLoginSel(p);
          setLoginHost(session.config.openaiCompatHost ?? "");
          setLoginKey("");
          setLoginStep("host");
        } else if (input2 === "r" && p?.needsKey) {
          // Replace a stored key: jump to key entry even if already signed in.
          setLoginSel(p);
          setLoginKey("");
          setLoginStep("key");
        } else if (input2 === "o" && p?.supportsOAuth && session.startOAuth) {
          // Subscription (OAuth) login: open the browser, then collect the
          // pasted callback code in the "oauth" step.
          setLoginSel(p);
          setLoginKey("");
          setLoginUrl("");
          setLoginStep("oauth");
          session.startOAuth(p.id).then(
            (url) => setLoginUrl(url),
            (err: unknown) => {
              setLoginOpen(false);
              push({
                kind: "system",
                text: `✗ login failed: ${err instanceof Error ? err.message : String(err)}`,
              });
            },
          );
        } else if (input2 === "x" && p && signedIn.includes(p.id)) {
          // Forget this provider's stored key.
          session.removeApiKey(p.id);
          setSignedIn(session.signedInProviders());
        }
        return;
      }
      if (loginStep === "host") {
        // Type/paste the base URL (e.g. https://agentrouter.org/v1), then Enter
        // to move on to the optional API key.
        if (key.return) {
          if (loginHost.trim()) {
            setLoginKey("");
            setLoginStep("key");
          }
        } else if (key.backspace || key.delete) {
          setLoginHost((h) => h.slice(0, -1));
        } else if (input2 && !key.ctrl && !key.meta) {
          setLoginHost((h) => h + input2);
        }
        return;
      }
      if (loginStep === "oauth") {
        // Collect the pasted `code#state` from the browser's callback page.
        if (key.return) {
          const pasted = loginKey.trim();
          const p = loginSel;
          setLoginOpen(false);
          if (p && pasted && session.completeOAuth) {
            session.completeOAuth(p.id, pasted).then(
              () => {
                push({ kind: "system", text: `✓ signed in to ${p.id} (subscription)` });
                switchTo(p); // no key: tokens are stored — continues into the model picker
              },
              (err: unknown) => {
                push({
                  kind: "system",
                  text: `✗ login failed: ${err instanceof Error ? err.message : String(err)}`,
                });
              },
            );
          }
        } else if (key.backspace || key.delete) {
          setLoginKey((k) => k.slice(0, -1));
        } else if (input2 && !key.ctrl && !key.meta) {
          setLoginKey((k) => k + input2);
        }
        return;
      }
      // step === "key": collect the secret, masked in the overlay.
      if (key.return) {
        if (loginSel?.needsHost) {
          // openai-compat: key is optional (local hosts need none); host is set.
          finishOpenAICompat(loginHost, loginKey.trim() || undefined);
        } else {
          if (loginSel && loginKey.trim()) switchTo(loginSel, loginKey.trim());
          setLoginOpen(false);
        }
      } else if (key.backspace || key.delete) {
        setLoginKey((k) => k.slice(0, -1));
      } else if (input2 && !key.ctrl && !key.meta) {
        setLoginKey((k) => k + input2);
      }
    },
    { isActive: loginOpen },
  );

  // /sdd interview overlay: type an answer, Enter advances to the next question, and
  // the last Enter resolves the awaited `ask` promise so the spec build continues.
  // Esc resolves early, padding the remaining answers as blank ("proceed with what
  // you gave"). Both paths log the finished Q&A to the transcript.
  useInput(
    (input2, key) => {
      if (!interview) return;
      const finish = (answers: string[]): void => {
        const qa = interview.questions.map(
          (q, i) => `  ✓ ${q} → ${answers[i]?.trim() || "(skipped)"}`,
        );
        push({ kind: "system", text: `▸ /sdd interview:\n${qa.join("\n")}` });
        interview.resolve(answers);
        setInterview(null);
        setInterviewInput("");
      };
      if (key.escape) {
        finish(interview.questions.map((_, i) => interview.answers[i] ?? ""));
        return;
      }
      if (key.return) {
        const answers = [...interview.answers, interviewInput.trim()];
        if (answers.length >= interview.questions.length) finish(answers);
        else {
          setInterview({ ...interview, answers });
          setInterviewInput("");
        }
        return;
      }
      if (key.backspace || key.delete) setInterviewInput((s) => s.slice(0, -1));
      else if (input2 && !key.ctrl && !key.meta) setInterviewInput((s) => s + input2);
    },
    { isActive: interview !== null },
  );

  const handleSlash = useCallback(
    async (raw: string): Promise<void> => {
      const [cmd, ...rest] = raw.slice(1).trim().split(/\s+/);
      switch (cmd) {
        case "help":
        case "?":
          push({ kind: "help" });
          break;
        case "clear": {
          session.agent.reset();
          setItems([]);
          setQueue([]);
          setScrollOffset(0);
          // Classic: <Static> only appends — remount it (new key) and blank the
          // screen + scrollback so the cleared transcript really disappears; the
          // newline pad re-anchors the prompt to the bottom of the window.
          // 3J comes FIRST deliberately: syncedStdout rewrites Ink's 2J+3J+H
          // clearTerminal to spare the scrollback, but leaves this order alone.
          // Fullscreen just resets state — the fixed frame repaints itself.
          setStaticGen((g) => g + 1);
          if (!fullscreen) {
            const ESC = String.fromCharCode(27);
            rawStdout?.write(`${ESC}[3J${ESC}[2J${ESC}[H${"\n".repeat(Math.max(0, rows - 1))}`);
          }
          setInTok(0);
          setOutTok(0);
          setCtxUsed(0);
          setSddTasks([]);
          setTeamMembers([]);
          setTeamSel(0);
          setTeamDetailOpen(false);
          setTeamFeeds(new Map());
          break;
        }
        case "exit":
        case "quit":
          exit();
          break;
        case "models":
          await openPicker();
          break;
        case "catalog": {
          const q = rest.join(" ").trim();
          push({ kind: "system", text: "loading models.dev catalog…" });
          try {
            const catalog = await fetchCatalog();
            const matches = searchCatalog(catalog, q, 25);
            if (matches.length === 0) {
              push({ kind: "system", text: `no catalog models match "${q}"` });
            } else {
              const lines = matches.map((m) => {
                const ctx = m.contextWindow ? ` · ${Math.round(m.contextWindow / 1000)}k ctx` : "";
                const cost =
                  m.inputCost != null ? ` · $${m.inputCost}/$${m.outputCost ?? "?"} per 1M` : "";
                return `  ${m.provider}/${m.id}${ctx}${cost}${m.toolCall ? " · tools" : ""}`;
              });
              push({
                kind: "system",
                text: `models.dev — ${catalog.length} models, top ${matches.length}:\n${lines.join("\n")}`,
              });
            }
          } catch (err) {
            push({
              kind: "system",
              text: `catalog failed: ${err instanceof Error ? err.message : String(err)}`,
            });
          }
          break;
        }
        case "compact": {
          // On success the agent emits a `context_compacted` event that the bus
          // handler renders; only the no-op needs its own message here.
          const result = await session.compact();
          if (result.after >= result.before) {
            push({ kind: "system", text: "context already compact — nothing to trim" });
          }
          break;
        }
        case "cost": {
          // Token totals accumulate from each turn's usage; pricing comes from the
          // models.dev catalog (per-1M USD), so the dollar estimate only shows for
          // listed hosted models — local backends have no published price.
          const meta = findModelById(cachedCatalogSync(), model, providerLabel);
          const win = session.agent.effectiveContextWindow();
          const usd =
            meta?.inputCost != null
              ? (inTok / 1e6) * meta.inputCost + (outTok / 1e6) * (meta.outputCost ?? 0)
              : undefined;
          const lines = [
            `model: ${providerLabel}/${model}`,
            `tokens this session: in ${inTok.toLocaleString()} · out ${outTok.toLocaleString()}`,
            win ? `context window: ${Math.round(win / 1000)}k` : "",
            meta?.inputCost != null
              ? `pricing: $${meta.inputCost}/$${meta.outputCost ?? "?"} per 1M tokens`
              : "pricing: not in catalog (local or unlisted model)",
            usd != null ? `estimated cost: $${usd.toFixed(4)}` : "",
          ].filter(Boolean);
          push({ kind: "system", text: lines.join("\n") });
          break;
        }
        case "config": {
          const c = session.config;
          const win = c.context.window;
          const lines = [
            "config file: ~/.arterm/config.json  (edit basics with `arterm init`)",
            `provider: ${c.provider} · model: ${c.model} · temperature: ${c.temperature}`,
            `permission mode: ${permMode}${c.confirmDestructive ? " · confirm-destructive" : ""}`,
            `session log: ${c.session.mode}${
              c.session.mode !== "off" && c.session.maxSessions
                ? ` (keep ${c.session.maxSessions})`
                : ""
            }`,
            `context: ${c.context.strategy}${win ? ` · window ${Math.round(win / 1000)}k` : ""}${
              c.context.compactAtPercent
                ? ` · compact @${Math.round(c.context.compactAtPercent * 100)}%`
                : ""
            }`,
            `memory: ${c.memory.mode}${
              c.memory.mode !== "off" ? ` · engine ${c.memory.engine ?? "legacy"}` : ""
            }`,
            `fleet: concurrency ${c.fleet.concurrency ?? 4} · isolation ${c.fleet.isolation ?? "none"}`,
            `arbiter: ${c.arbiter.enabled ? "on" : "off"} · catalog: ${
              c.catalog?.enabled === false ? "off" : "on"
            }`,
          ];
          push({ kind: "system", text: lines.join("\n") });
          break;
        }
        case "mode": {
          const arg = rest.join(" ").trim().toLowerCase();
          if (!arg) {
            const i = MODE_CYCLE.indexOf(permMode);
            applyMode(MODE_CYCLE[(i + 1) % MODE_CYCLE.length] ?? "ask");
          } else if ((PERMISSION_MODES as string[]).includes(arg)) {
            applyMode(arg as PermissionMode);
          } else {
            push({ kind: "system", text: `unknown mode: ${arg} (ask | auto | plan | yolo)` });
          }
          break;
        }
        case "ask":
        case "auto":
        case "plan":
        case "yolo":
          applyMode(cmd);
          break;
        case "goal": {
          const g = rest.join(" ").trim();
          if (!g) {
            push({ kind: "system", text: "usage: /goal <description>" });
          } else if (session.autonomy.state === "running" || session.autonomy.state === "paused") {
            push({ kind: "system", text: "a goal is already running — /stop it first" });
          } else {
            void session.autonomy.start(g);
          }
          break;
        }
        case "autonomy": {
          const [modeArg = "", ...goalParts] = rest.join(" ").trim().split(/\s+/);
          const mode = modeArg.toLowerCase();
          const modes: AutonomyMode[] = ["once", "eternal", "parallel", "phased", "team"];
          const g = goalParts.join(" ").trim();
          if (!modes.includes(mode as AutonomyMode) || !g) {
            push({
              kind: "system",
              text: "usage: /autonomy <once|eternal|parallel|phased|team> <goal>",
            });
          } else if (session.autonomy.state === "running" || session.autonomy.state === "paused") {
            push({ kind: "system", text: "a goal is already running — /stop it first" });
          } else if (!session.autonomy.setMode(mode as AutonomyMode)) {
            push({ kind: "system", text: "can't switch autonomy mode while a goal is active" });
          } else {
            void session.autonomy.start(g);
          }
          break;
        }
        case "team": {
          const g = rest.join(" ").trim();
          if (!g) {
            push({ kind: "system", text: "usage: /team <task>  (leader assembles an agent team)" });
          } else if (
            session.autonomy.state === "running" ||
            session.autonomy.state === "paused" ||
            session.sdd.state === "running" ||
            session.sdd.state === "paused"
          ) {
            push({ kind: "system", text: "a run is already active — /stop it first" });
          } else if (!session.autonomy.setMode("team")) {
            push({ kind: "system", text: "can't switch autonomy mode while a goal is active" });
          } else {
            setTeamMembers([]);
            push({ kind: "system", text: `⚑ /team: assembling a team for "${g.slice(0, 80)}"…` });
            void session.autonomy.start(g);
          }
          break;
        }
        case "agents": {
          const defs = session.agentDefs ?? [];
          if (defs.length === 0) {
            push({
              kind: "system",
              text:
                "no agent definitions found — add markdown files to .arterm/agents/ (project) " +
                "or ~/.arterm/agents/ (global): frontmatter name/description/tools, body = instructions",
            });
          } else {
            const lines = defs.map(
              (d) =>
                `  ${d.name} [${d.source}]${d.description ? ` — ${d.description}` : ""}${
                  d.tools ? `  (tools: ${d.tools.join(", ")})` : ""
                }`,
            );
            push({
              kind: "system",
              text: `agent definitions (used by /team):\n${lines.join("\n")}`,
            });
          }
          break;
        }
        case "copy": {
          // Copy the last assistant reply via OSC 52 — the terminal owns the
          // clipboard write, so this works over SSH too, and it reaches replies
          // longer than the screen (drag-select only covers what is visible).
          const last = [...items].reverse().find((i) => i.kind === "assistant");
          if (!last || last.kind !== "assistant") {
            push({ kind: "system", text: "nothing to copy yet — no assistant reply" });
          } else if (!rawStdout) {
            push({ kind: "system", text: "clipboard unavailable (no terminal stdout)" });
          } else {
            rawStdout.write(osc52Sequence(last.text));
            push({
              kind: "system",
              text: `⧉ copied the last reply to the clipboard (${last.text.length} chars)`,
            });
          }
          break;
        }
        case "sdd": {
          const skipInterview = /(^|\s)--yes\b/.test(` ${rest.join(" ")}`);
          const brief = rest
            .join(" ")
            .replace(/(^|\s)--yes\b/g, "")
            .trim();
          if (!brief) {
            push({
              kind: "system",
              text: "usage: /sdd <brief>  (add --yes to skip the interview)",
            });
          } else if (session.sdd.state === "running" || session.sdd.state === "paused") {
            push({ kind: "system", text: "an /sdd run is already active — /stop it first" });
          } else {
            // Fresh board for this run; pass the interactive interview unless --yes.
            setSddTasks([]);
            setInterview(null);
            push({ kind: "system", text: `▸ /sdd: planning "${brief}"…` });
            void session.sdd.run(brief, skipInterview ? undefined : askInterview);
          }
          break;
        }
        case "steer": {
          const note = rest.join(" ").trim();
          if (!note) push({ kind: "system", text: "usage: /steer <note>" });
          else session.autonomy.steer(note);
          break;
        }
        case "pause":
          session.autonomy.pause();
          session.sdd.pause();
          break;
        case "resume":
          session.autonomy.resume();
          session.sdd.resume();
          break;
        case "stop":
          session.autonomy.stop();
          session.sdd.stop();
          break;
        case "mcp": {
          const sub = rest[0] ?? "";
          if (sub !== "" && sub !== "check" && sub !== "reload") {
            push({ kind: "system", text: "usage: /mcp [check|reload]" });
            break;
          }
          // The server set is fixed at startup (config-only), so an empty summary
          // means there is nothing to list, probe, or reconnect.
          if (session.mcpServers.length === 0) {
            push({
              kind: "system",
              text: "no MCP servers configured — add them to ~/.arterm/config.json → mcpServers",
            });
            break;
          }
          if (sub === "check") {
            if (!session.checkExtensions) {
              push({ kind: "system", text: "health check unavailable in this session" });
              break;
            }
            push({ kind: "system", text: "checking MCP servers…" });
            try {
              const { mcp } = await session.checkExtensions();
              const lines = mcp.map((r) =>
                r.ok
                  ? `  ✓ ${r.name} — ${r.latencyMs}ms · ${r.toolCount ?? 0} tool(s)`
                  : `  ✗ ${r.name} — ${r.error ?? "unknown"}`,
              );
              push({ kind: "system", text: `MCP health:\n${lines.join("\n")}` });
            } catch (e) {
              push({ kind: "system", text: `mcp check failed: ${(e as Error).message}` });
            }
            break;
          }
          if (sub === "reload") {
            if (!session.reloadExtensions) {
              push({ kind: "system", text: "reload unavailable in this session" });
              break;
            }
            push({ kind: "system", text: "reconnecting MCP servers…" });
            try {
              const res = await session.reloadExtensions();
              const added =
                res.addedTools.length > 0
                  ? `\n  +${res.addedTools.length} new tool(s): ${res.addedTools.join(", ")}`
                  : "";
              push({ kind: "system", text: `MCP servers:\n${mcpSummaryLines(res.mcp)}${added}` });
            } catch (e) {
              push({ kind: "system", text: `mcp reload failed: ${(e as Error).message}` });
            }
            break;
          }
          push({ kind: "system", text: `MCP servers:\n${mcpSummaryLines(session.mcpServers)}` });
          break;
        }
        case "plugins": {
          const sub = rest[0] ?? "";
          // Unlike MCP, the plugin dir can gain entries mid-session, so check and
          // reload must run even when nothing was loaded at startup.
          if (sub === "check") {
            if (!session.checkExtensions) {
              push({ kind: "system", text: "health check unavailable in this session" });
              break;
            }
            push({ kind: "system", text: "checking plugins…" });
            try {
              const { plugins } = await session.checkExtensions();
              if (plugins.length === 0) {
                push({
                  kind: "system",
                  text: "no plugins found — drop them in ~/.arterm/plugins/<name>/",
                });
                break;
              }
              const lines = plugins.map((r) =>
                r.ok
                  ? `  ✓ ${r.name} — ${
                      r.toolCount !== undefined
                        ? `${r.toolCount} tool(s)`
                        : "not loaded yet — /plugins reload"
                    }`
                  : `  ✗ ${r.name} — ${r.error ?? "unknown"}`,
              );
              push({ kind: "system", text: `Plugin health:\n${lines.join("\n")}` });
            } catch (e) {
              push({ kind: "system", text: `plugins check failed: ${(e as Error).message}` });
            }
            break;
          }
          if (sub === "reload") {
            if (!session.reloadExtensions) {
              push({ kind: "system", text: "reload unavailable in this session" });
              break;
            }
            push({ kind: "system", text: "rescanning plugins…" });
            try {
              const res = await session.reloadExtensions();
              const added =
                res.addedTools.length > 0
                  ? `\n  +${res.addedTools.length} new tool(s): ${res.addedTools.join(", ")}`
                  : "";
              const body =
                res.plugins.length === 0
                  ? "no plugins found — drop them in ~/.arterm/plugins/<name>/"
                  : `Plugins:\n${pluginSummaryLines(res.plugins)}${added}`;
              push({ kind: "system", text: body });
            } catch (e) {
              push({ kind: "system", text: `plugins reload failed: ${(e as Error).message}` });
            }
            break;
          }
          if (sub !== "") {
            push({ kind: "system", text: "usage: /plugins [check|reload]" });
            break;
          }
          const ps = session.plugins;
          if (ps.length === 0) {
            push({
              kind: "system",
              text: "no plugins loaded — drop them in ~/.arterm/plugins/<name>/ and set trust in config",
            });
          } else {
            push({ kind: "system", text: `Plugins:\n${pluginSummaryLines(ps)}` });
          }
          break;
        }
        case "skills": {
          const sk = session.skills;
          if (sk.length === 0) {
            push({
              kind: "system",
              text: "no skills found — add markdown files to ~/.arterm/skills/",
            });
          } else {
            push({
              kind: "system",
              text: `Skills:\n${sk.map((s) => `  ${s.name} — ${s.description}`).join("\n")}`,
            });
          }
          break;
        }
        case "skill": {
          const sname = rest.join(" ").trim();
          const body = sname ? session.getSkillBody(sname) : undefined;
          if (!body) {
            push({ kind: "system", text: `unknown skill: ${sname || "(none)"} — see /skills` });
            break;
          }
          push({ kind: "system", text: `▸ running skill: ${sname}` });
          push({ kind: "user", text: `(skill: ${sname})` });
          const controller = new AbortController();
          abortRef.current = controller;
          await session.agent.run(body, controller.signal);
          abortRef.current = null;
          break;
        }
        case "model": {
          const arg = rest.join(" ").trim();
          if (!arg) {
            await openPicker();
            break;
          }
          const n = Number(arg);
          const picked = Number.isInteger(n) ? pickerModels[n - 1] : undefined;
          if (picked) chooseModel(picked);
          else choose(arg);
          break;
        }
        case "login":
          openLogin();
          break;
        default:
          push({ kind: "system", text: `unknown command: /${cmd} — type ? for help` });
      }
    },
    [
      session,
      exit,
      openPicker,
      openLogin,
      choose,
      chooseModel,
      push,
      pickerModels,
      applyMode,
      permMode,
      inTok,
      outTok,
      model,
      providerLabel,
      askInterview,
      items,
      rawStdout,
      rows,
      fullscreen,
    ],
  );

  // The plain single-agent turn (also the decline path of the team suggestion).
  const runPlain = useCallback(
    async (text: string) => {
      push({ kind: "user", text });
      const controller = new AbortController();
      abortRef.current = controller;
      await session.agent.run(text, controller.signal);
      abortRef.current = null;
    },
    [session, push],
  );

  // Executes one submitted line (slash command / steering / plain turn). Split
  // out of `submit` so queued prompts can be dispatched later without re-doing
  // the input/history bookkeeping their original Enter already did.
  const dispatch = useCallback(
    async (text: string) => {
      if (text === "?") {
        push({ kind: "help" });
        return;
      }
      if (text.startsWith("/")) {
        await handleSlash(text);
        return;
      }
      // While a goal is running, plain text steers the autonomous run.
      if (session.autonomy.state === "running" || session.autonomy.state === "paused") {
        push({ kind: "user", text });
        session.autonomy.steer(text);
        return;
      }
      // A large-looking prompt gets a y/N offer to run as an agent team instead
      // (config.team.suggest gates this; declining runs the normal single turn).
      if (
        session.config.team?.suggest !== false &&
        session.sdd.state !== "running" &&
        session.sdd.state !== "paused" &&
        looksLikeBigTask(text)
      ) {
        setTeamSuggest(text);
        return;
      }
      await runPlain(text);
    },
    [session, handleSlash, push, runPlain],
  );

  const submit = useCallback(
    async (value: string) => {
      const text = value.trim();
      setInput("");
      if (!text) {
        // Enter on an empty prompt toggles the selected member's drill-down view.
        if (teamMembers.length > 0) setTeamDetailOpen((v) => !v);
        return;
      }
      setHistory((h) => historyPush(h, text));
      // The prompt stays live while a turn runs: anything submitted mid-turn is
      // queued and dispatched FIFO once the loop is idle again. (Autonomy runs
      // are exempt — there, plain text steers the engine immediately.)
      if (statusRef.current !== "idle" && session.autonomy.state === "idle") {
        setQueue((q) => [...q, text]);
        return;
      }
      await dispatch(text);
    },
    [session, dispatch, teamMembers.length],
  );

  // Drains the oldest queued prompt once the loop is idle again. Event-driven —
  // called on turn_end / autonomy completion (via drainRef) and self-chained
  // after each dispatched item — never effect-driven, so it cannot stall on
  // React's passive-effect scheduling. The one-tick deferral lets the finishing
  // run fully unwind first (runPlain clears abortRef AFTER turn_end fires).
  const drainQueue = useCallback(() => {
    setTimeout(() => {
      if (queueBusyRef.current || statusRef.current !== "idle") return;
      if (autoStateRef.current !== "idle" || teamSuggestRef.current !== null) return;
      const next = queueRef.current[0];
      if (next === undefined) return;
      queueBusyRef.current = true;
      setQueue((q) => q.slice(1));
      void (async () => {
        try {
          await dispatch(next);
        } finally {
          queueBusyRef.current = false;
          drainRef.current();
        }
      })();
    }, 0);
  }, [dispatch]);
  drainRef.current = drainQueue;

  // y/N confirm for the /team offer: y routes the prompt to /team, anything else
  // (n, Enter, Esc, any other character) falls through to the normal run.
  useInput(
    (input2, key) => {
      const text = teamSuggest;
      if (!text) return;
      if (input2 === "y" || input2 === "Y") {
        setTeamSuggest(null);
        void handleSlash(`/team ${text}`);
      } else if (input2 || key.return || key.escape) {
        setTeamSuggest(null);
        void runPlain(text);
      }
    },
    { isActive: teamSuggest !== null },
  );

  // Up/Down recall previously submitted prompts (shell-style history) — except
  // while a team board is visible and the prompt is empty, where they move the
  // member selection instead (the board hint documents this takeover).
  const boardNav = teamMembers.length > 0 && input === "";
  const onHistoryPrev = (): void => {
    if (boardNav) {
      setTeamSel((s) => Math.max(0, s - 1));
      return;
    }
    const { nav, value } = historyUp(history, input);
    setHistory(nav);
    setInput(value);
  };
  const onHistoryNext = (): void => {
    if (boardNav) {
      setTeamSel((s) => Math.min(teamMembers.length - 1, s + 1));
      return;
    }
    const { nav, value } = historyDown(history, input);
    setHistory(nav);
    setInput(value);
  };

  const busy = status !== "idle";
  const mode = permMode.toUpperCase();

  // Finished items are printed ONCE into the terminal's scrollback via <Static>;
  // everything below it is Ink's small in-place dynamic region. Keeping that
  // region far below the terminal height matters: at >= stdout.rows Ink clears
  // and rewrites the whole terminal every render (stutter + broken scrollback).
  const liveMaxRows = Math.max(4, rows - 16);

  // Fullscreen: feed the arrow router the freshest state each render (it is
  // memoized once and reads through these refs), and clamp the scroll offset
  // to the measured content.
  overlayOpenRef.current = pickerOpen || loginOpen || interview !== null;
  arrowHistoryRef.current = (dir) => {
    if (teamSuggest) {
      scrollBy(dir === "up" ? 1 : -1);
      return;
    }
    if (dir === "up") onHistoryPrev();
    else onHistoryNext();
  };
  const maxOffset = Math.max(0, totalLines - viewportRows);
  maxOffsetRef.current = maxOffset;
  const clampedOffset = Math.min(scrollOffset, maxOffset);

  const footer = (
    <>
      {sddTasks.length > 0 ? <SddBoard tasks={sddTasks} columns={columns} /> : null}
      {teamMembers.length > 0 ? (
        <TeamBoard
          members={teamMembers}
          columns={columns}
          selected={teamSel}
          detailOpen={teamDetailOpen}
          feed={
            teamFeeds.get(teamMembers[Math.min(teamSel, teamMembers.length - 1)]?.id ?? "") ?? []
          }
        />
      ) : null}
      {teamSuggest ? (
        <Box>
          <Text color="magenta" bold>
            ⚑ This looks like a large task
          </Text>
          <Text color="gray"> — run it as an agent team? </Text>
          <Text color="magenta" bold>
            [y/N]
          </Text>
        </Box>
      ) : null}
      {interview ? (
        <SddInterview
          questions={interview.questions}
          answers={interview.answers}
          current={interviewInput}
        />
      ) : pending ? (
        <PermissionPrompt pending={pending} />
      ) : pickerOpen ? (
        <ModelPicker
          models={filteredPickerModels}
          index={pickerIndex}
          current={model}
          loading={pickerLoading}
          query={pickerQuery}
        />
      ) : loginOpen ? (
        <LoginOverlay
          step={loginStep}
          providers={session.loginProviders}
          index={loginIndex}
          current={providerLabel}
          signedIn={signedIn}
          selected={loginSel ?? undefined}
          keyValue={loginKey}
          hostValue={loginHost}
          oauthUrl={loginUrl}
        />
      ) : (
        <Box marginTop={1} flexDirection="column">
          {busy && autoState === "idle" ? (
            // The turn runs behind a LIVE prompt: keep typing, Enter queues the
            // next message(s), Esc cancels the turn (and drops the queue).
            <Text color="yellow">
              ● working…{" "}
              <Text color="gray" dimColor>
                Esc cancels · Enter queues the next message
              </Text>
            </Text>
          ) : null}
          {queue.slice(0, 3).map((q, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: queue is order-only
            <Text key={i} color="gray" dimColor wrap="truncate">
              ⏳ {q}
            </Text>
          ))}
          {queue.length > 3 ? (
            <Text color="gray" dimColor>
              ⏳ +{queue.length - 3} more queued
            </Text>
          ) : null}
          <InputLine
            active={!teamSuggest}
            value={input}
            commands={COMMANDS}
            columns={columns}
            onChange={setInput}
            onSubmit={submit}
            onHelp={() => push({ kind: "help" })}
            onHistoryPrev={onHistoryPrev}
            onHistoryNext={onHistoryNext}
            externalArrows={fullscreen && !mouseCapture}
          />
        </Box>
      )}
      {autoState !== "idle" ? (
        <Box>
          <Text color="magenta" bold>
            {autoState === "paused" ? "⏸ GOAL" : "◆ GOAL"}
          </Text>
          <Text color="gray">
            {"  "}
            step {autoStep} · {goalText.slice(0, 64)}
          </Text>
        </Box>
      ) : null}
      <StatusBar
        provider={providerLabel}
        model={model}
        status={status}
        inTok={inTok}
        outTok={outTok}
        ctxUsed={ctxUsed}
        ctxWindow={session.agent.effectiveContextWindow() ?? DEFAULT_CTX}
        toolCount={session.toolCount}
        mode={mode}
        columns={columns}
        shiftSelect={mouseCapture}
      />
    </>
  );

  if (fullscreen) {
    // The whole window is one fixed-height frame (rows-1 keeps Ink's trailing
    // newline on-screen and stays under its clear-everything threshold): the
    // transcript viewport fills the space above a footer that is pinned purely
    // by being the column's last child — scrolling happens INSIDE the viewport,
    // so the footer never moves, exactly like Claude Code's fullscreen renderer.
    return (
      <Box flexDirection="column" width={columns} height={Math.max(4, rows - 1)}>
        <Transcript
          items={items}
          live={live}
          viewportRows={viewportRows}
          scrollOffset={clampedOffset}
          columns={columns}
          onMeasure={handleMeasure}
        />
        <Box ref={bottomRef} flexDirection="column" flexShrink={0}>
          {clampedOffset > 0 ? (
            <Text color="gray" dimColor>
              ↑ {clampedOffset} satır yukarıda · tekerleği aşağı çevir / mesaj gönder = en alta dön
            </Text>
          ) : null}
          {footer}
        </Box>
      </Box>
    );
  }

  return (
    <>
      <Static key={staticGen} items={items}>
        {(item, i) => (
          <Box key={i} width={columns}>
            <Item item={item} />
          </Box>
        )}
      </Static>
      <AnchoredRegion
        rows={rows}
        columns={columns}
        snapKey={`${staticGen}:${items.length}:${rows}:${columns}`}
      >
        {live ? <LiveMessage text={live} maxRows={liveMaxRows} columns={columns} /> : null}
        {footer}
      </AnchoredRegion>
    </>
  );
}
