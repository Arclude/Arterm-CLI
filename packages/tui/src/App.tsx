import {
  type AutonomyMode,
  type ContextBreakdown,
  type McpServerSummary,
  type ModelInfo,
  PERMISSION_MODES,
  type PermissionAsker,
  type PermissionMode,
  type PermissionOrigin,
  type PluginSummary,
  type SddTaskState,
  cachedCatalogSync,
  fetchCatalog,
  findModelById,
  priceUsage,
  searchCatalog,
  toolCallPreview,
} from "@arterm/core";
import type React from "react";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ComposerFrame } from "./Composer.js";
import { ContextPanel } from "./ContextPanel.js";
import { LoginOverlay } from "./LoginOverlay.js";
import { Item } from "./MessageList.js";
import { ModelPicker } from "./ModelPicker.js";
import { type PendingPermission, PermissionPrompt } from "./PermissionPrompt.js";
import { SddBoard, type SddBoardTask } from "./SddBoard.js";
import { SddInterview } from "./SddInterview.js";
import { type Status, StatusBar } from "./StatusBar.js";
import { TeamBoard, type TeamBoardKind, type TeamBoardMember } from "./TeamBoard.js";
import { agentColor } from "./agentColor.js";
import { type ArrowDir, createArrowRouter, parseArrowChunk } from "./arrowRouter.js";
import { OSC52_MAX_CHARS, copyToClipboard } from "./clipboard.js";
import {
  type HistoryNav,
  commandSuggestion,
  emptyHistory,
  historyDown,
  historyPush,
  historyUp,
  reduceInput,
} from "./editing.js";
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
} from "./ink.js";
import { formatRateLimits } from "./limitsView.js";
import { Markdown } from "./markdown.js";
import { appendFeed, formatMemberEvent } from "./teamFeed.js";
import { looksLikeBigTask } from "./teamSuggest.js";
import { truncateDisplay } from "./terminalWidth.js";
import { theme } from "./theme.js";
import type { DisplayItem, LoginProvider, Session } from "./types.js";
import { glyphs } from "./uiGlyphs.js";

/** Soft context-window estimate for the status-bar gauge (local models rarely report one). */
const DEFAULT_CTX = 32768;

/**
 * Bridged member events that carry telemetry rather than activity. Kept as a set
 * so the board's update runs for a `usage` or `context_usage` too — those have no
 * activity string, and gating on activity alone is what left the cells' token and
 * context columns permanently empty.
 */
const RICH = new Set(["tool_call", "usage", "context_usage"]);

/** Streamed tokens repaint the live message at most this often (~22 fps). */
const LIVE_FLUSH_MS = 45;

/** Custom single-line input so `?` on an empty line opens help. */
function InputLine({
  active,
  value,
  commands,
  columns,
  borderColor = "gray",
  workingSince,
  hint,
  onChange,
  onSubmit,
  onHelp,
  onHistoryPrev,
  onHistoryNext,
  onTab,
  externalArrows = false,
}: {
  active: boolean;
  value: string;
  commands: readonly string[];
  columns: number;
  /** Frame color for the typing area — mirrors the mode badge. */
  borderColor?: string;
  /** Epoch ms the running turn began; drives the top rail's spinner and clock. */
  workingSince?: number | undefined;
  /** The bottom rail's text — the keys that apply right now. */
  hint: string;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
  onHelp: () => void;
  onHistoryPrev: () => void;
  onHistoryNext: () => void;
  /**
   * Tab with nothing to complete. Ownership sits here rather than in a second
   * always-on handler: completing changes the prompt, so a separate handler
   * inspecting it in the same keypress would race the commit and both fire.
   */
  onTab?: () => void;
  /** ↑/↓ are owned by App: its arrow router (fullscreen) or board navigation. */
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
      // Never double-handle arrows when App owns them — the fullscreen router
      // separates wheel-synthesized arrows (scroll) from keyboard ones (history),
      // and an open board drill-down steps its rows with them.
      if (externalArrows && (key.upArrow || key.downArrow)) return;
      // Tab completes a slash command to its first match; with nothing to
      // complete it falls through to `onTab` (the board's row step). Shift+Tab is
      // the permission-mode cycle, handled in App — leave it alone.
      if (key.tab && !key.shift) {
        const s = commandSuggestion(v, commands);
        if (s) onChange(v + s);
        else onTab?.();
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
  // The frame is drawn as text (see `Composer.tsx`) rather than by Ink's border,
  // so it can carry a title, a live spinner and a hint. It stays a single
  // fixed-width column Box with `<Text>` children: what sent MultiApp's layout
  // into a measure/re-layout oscillation (unbounded re-renders, an OOM in its
  // tests) was WRAPPING this component from outside, and nothing here measures
  // an element — the widths are arithmetic on strings.
  return (
    <ComposerFrame
      value={value}
      suggestion={suggestion}
      columns={columns}
      color={borderColor}
      workingSince={workingSince}
      hint={hint}
    />
  );
}

/**
 * What a rewind cannot put back. Printed with every restore, because a partial
 * undo that reads as a total one is how people lose work they believed was
 * recoverable — shell side effects and worktree-isolated sub-agent edits are
 * simply not in the store.
 */
const REWIND_LIMITS =
  "  (not undone: anything `bash` did, sub-agent edits in isolated worktrees, " +
  "directory changes, symlinked/hard-linked files, and network or DB effects)";

/** One line describing what a restore actually touched. */
function restoreSummary(r: {
  restored: number;
  deleted: number;
  unchanged: number;
  skippedLinks: number;
}): string {
  const parts = [`${r.restored} restored`];
  if (r.deleted) parts.push(`${r.deleted} removed`);
  if (r.unchanged) parts.push(`${r.unchanged} already matching`);
  if (r.skippedLinks) parts.push(`${r.skippedLinks} skipped (links)`);
  return parts.join(", ");
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
  "limits",
  "rewind",
  "redo",
  "mouse",
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
  "context",
  "cost",
  "config",
  "mcp",
  "plugins",
  "skills",
  "skill",
  "mode",
  "permissions",
  "auto",
  "plan",
  "ask",
  "yolo",
  "exit",
  "quit",
] as const;

/**
 * Collapse a value to one transcript line. A sub-agent's task is no longer a
 * sentence — an /sdd worker is handed the spec and its dependencies' output — so
 * slicing raw text spills a document's second, third and fourth lines onto a line
 * meant to be a label. The first line of a task is its title.
 */
function oneLine(text: string, max: number): string {
  const first = text.split("\n")[0]?.trim() ?? "";
  return truncateDisplay(first, max);
}

/** How a remotely-answered permission reads in the transcript. */
const PERMISSION_ANSWER_LABEL: Record<string, string> = {
  allow: "allowed once",
  allow_always: "always allowed",
  deny: "denied",
};

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

  const cut = contentRows > 0 ? Math.max(1, contentRows - Math.max(0, scrollOffset)) : undefined;
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
  initialPrompt,
  fullscreen = false,
  visible = true,
  onOpenSessions,
  onCycleSession,
  onCloseSession,
  onPendingChange,
  sessionsBadge,
  mouseCapture: mouseCaptureProp,
  onToggleMouse,
  version,
}: {
  session: Session;
  initialGoal?: string;
  /** First user message of a session created from the session panel. */
  initialPrompt?: string;
  /** Alternate-screen mode: pinned footer + in-app scroll (see runTui). */
  fullscreen?: boolean;
  /**
   * Multi-session: false keeps this App mounted (bus subscription, queue,
   * transcript all keep accumulating) but renders nothing and ignores input.
   */
  visible?: boolean;
  onOpenSessions?: () => void;
  onCycleSession?: (dir: -1 | 1) => void;
  /** Ctrl+X — close this session (the last one closes the whole app). */
  onCloseSession?: () => void;
  /** Reports whether a permission prompt is waiting (background-session badge). */
  onPendingChange?: (pending: boolean) => void;
  /** Multi-session summary for the status bar badge. */
  sessionsBadge?: { index: number; count: number; busyBackground: number };
  /**
   * The host's LIVE mouse-capture state (MultiApp owns the terminal modes and
   * the /mouse toggle can change it at runtime). Absent when standalone —
   * then the config value stands.
   */
  mouseCapture?: boolean;
  /** Flip mouse capture at runtime (for /mouse); returns the new state. */
  onToggleMouse?: () => boolean;
  /** CLI version for the status bar (single source: the binary). */
  version?: string;
}): React.ReactElement | null {
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
  /**
   * Where the fallback chain last landed, so the status bar can say who is really
   * answering. The `↪` transcript line scrolls away; this doesn't.
   */
  const [fallbackTo, setFallbackTo] = useState<{ provider: string; model: string } | null>(null);
  const [permMode, setPermMode] = useState<PermissionMode>(session.permissionMode);
  // Shift+Tab's slot past PLAN: while armed, a plain prompt launches an
  // autonomous goal run instead of a supervised single turn.
  const [autoArmed, setAutoArmed] = useState(false);
  const [autoState, setAutoState] = useState<"idle" | "running" | "paused" | "done" | "stopped">(
    "idle",
  );
  const [goalText, setGoalText] = useState("");
  const [autoStep, setAutoStep] = useState(0);
  const [pending, setPending] = useState<PendingPermission | null>(null);
  // Requests waiting behind the active prompt, tracked off `permission_queued`
  // (the broker queues concurrent asks — a fan-out shares one prompt).
  const [permQueued, setPermQueued] = useState(0);
  // Set from `permission_request`, which the broker emits immediately BEFORE it
  // calls our asker — so the prompt raised next knows which worker it belongs to.
  const permOriginRef = useRef<PermissionOrigin | undefined>(undefined);
  /** Board row currently marked "awaiting permission", so it can be handed back. */
  const permRowRef = useRef<string | undefined>(undefined);
  const [inTok, setInTok] = useState(0);
  const [outTok, setOutTok] = useState(0);
  const [ctxUsed, setCtxUsed] = useState(0);
  const [ctxEstimated, setCtxEstimated] = useState(true);
  const [ctxWindowLive, setCtxWindowLive] = useState<number | undefined>(undefined);
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
  // The main agent's own USD spend for the session, accumulated from its usage
  // events. Not a board cell: the leader is not a task that can finish, and its
  // live state is the status bar's job — but its cost belongs beside the fleet's.
  const [leaderCost, setLeaderCost] = useState(0);
  // /context: the panel, its measured composition, and the two things that have
  // already reshaped the window this session. Compactions and cleared results
  // are counted here because the events announcing them scroll away, and "why
  // is the history shorter than what I remember saying" is the question the
  // panel exists to answer.
  const [contextOpen, setContextOpen] = useState(false);
  const [contextBreakdown, setContextBreakdown] = useState<ContextBreakdown | undefined>(undefined);
  const [compactions, setCompactions] = useState<{
    count: number;
    last?: { before: number; after: number };
  }>({ count: 0 });
  const [clearedResults, setClearedResults] = useState(0);
  const contextOpenRef = useRef(false);
  contextOpenRef.current = contextOpen;
  // Which fan-out mode the board is showing: a /team roster or a parallel run's
  // per-round subtasks. Only the wording differs — the rows, the telemetry and
  // the navigation are the same. `team` wins if both could apply.
  const [boardKind, setBoardKind] = useState<TeamBoardKind>("team");
  // Board navigation: Ctrl+↑/↓ select a row (plain ↑/↓ stay prompt history),
  // Enter on an empty prompt opens its activity feed, and while that feed is open
  // plain ↑/↓ and Tab step rows too. Esc closes it. Feeds are per-row line rings.
  const [teamSel, setTeamSel] = useState(0);
  const [teamDetailOpen, setTeamDetailOpen] = useState(false);
  // The swarm board's live clock. Deliberately NOT a standing timer: the status
  // bar computes its clock inline for exactly this reason — a repaint every
  // second on an idle session is a cost paid forever for a number nobody is
  // reading. This one exists only while a member is actually running.
  const [swarmClock, setSwarmClock] = useState(() => Date.now());
  const swarmLive = teamMembers.some((m) => m.state === "running");
  useEffect(() => {
    if (!swarmLive) return;
    setSwarmClock(Date.now());
    const t = setInterval(() => setSwarmClock(Date.now()), 1000);
    return () => clearInterval(t);
  }, [swarmLive]);
  // Ref mirrors for the always-active Esc handlers below — a handler can fire
  // before the effect that would refresh its closure/subscription lands, so
  // gates are read through refs instead of isActive/closures.
  const teamDetailOpenRef = useRef(false);
  teamDetailOpenRef.current = teamDetailOpen;
  // The rows the board keys steer. A /team roster or a fan-out round owns them
  // when one is up; otherwise it is the /sdd graph, whose kanban is the only board
  // an /sdd run raises. Selection indexes THIS list, so both boards share one set
  // of handlers and one feed lookup.
  const boardRows: { id: string }[] = teamMembers.length > 0 ? teamMembers : sddTasks;
  const memberCountRef = useRef(0);
  memberCountRef.current = boardRows.length;
  const autoStateRef = useRef(autoState);
  autoStateRef.current = autoState;
  const pendingRef = useRef<PendingPermission | null>(null);
  pendingRef.current = pending;
  // Multi-session: the always-active handlers (Esc, raw stdin arrows) read this
  // instead of isActive so a hidden App never reacts to keys.
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
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
  // The terminal-mode escape writes (mouse capture, alternate scroll, classic
  // resize re-pad) live in MultiApp — they are process-global, and per-App
  // ownership would flap the modes on every session switch.
  const { stdout: rawStdout } = useStdout();
  // The host's live value wins: /mouse can flip capture at runtime, and this
  // App's scroll/arrow machinery has to follow the modes actually on the wire.
  const mouseCapture = mouseCaptureProp ?? (fullscreen && (session.config.tui?.mouse ?? false));
  // True when the arrow ROUTER owns ↑/↓ (it tells wheel-synthesized arrows from
  // keypresses). Read through a ref by the always-active board handler below.
  const routedArrows = fullscreen && !mouseCapture;
  const routedArrowsRef = useRef(routedArrows);
  routedArrowsRef.current = routedArrows;

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
    { isActive: visible && mouseCapture },
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
      if (!visibleRef.current || overlayOpenRef.current) return;
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
    { isActive: visible && fullscreen },
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

  // Wire the permission prompt into the agent's permission flow (once). The
  // request's origin (which sub-agent asked) and the queue depth behind it come
  // off the bus — see the `permission_request` / `permission_queued` cases below.
  useEffect(() => {
    const asker: PermissionAsker = (tool, args, signal) =>
      new Promise((resolve) => {
        const entry: PendingPermission = {
          tool,
          args,
          origin: permOriginRef.current,
          resolve: (answer) => {
            setPending((cur) => (cur === entry ? null : cur));
            resolve(answer);
          },
        };
        // Answered elsewhere (the desktop, via the status server): tear this
        // prompt down. The broker ignores what we resolve with at that point.
        signal?.addEventListener(
          "abort",
          () => {
            setPending((cur) => (cur === entry ? null : cur));
            resolve("deny");
          },
          { once: true },
        );
        setPending(entry);
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
        // The agent's own view of how full the context is — reported tokens
        // when the provider sends them, an estimate otherwise. Without this the
        // gauge sat at 0% on every backend that reports no usage, right up
        // until the agent compacted.
        case "context_usage":
          setCtxUsed(event.used);
          // Whether the fill is the provider's own number or our heuristic is
          // part of the fact, not a footnote: a local backend that reports no
          // usage produces a gauge built entirely from an estimate, and a panel
          // that showed both the same way would be claiming a precision it
          // does not have.
          setCtxEstimated(event.estimated);
          if (event.window) setCtxWindowLive(event.window);
          break;
        case "usage":
          if (event.usage.promptTokens) {
            setInTok((t) => t + (event.usage.promptTokens ?? 0));
            turnRef.current.inTok += event.usage.promptTokens;
          }
          if (event.usage.completionTokens) {
            setOutTok((t) => t + (event.usage.completionTokens ?? 0));
            turnRef.current.outTok += event.usage.completionTokens;
          }
          // The leader's own spend, so the board can name it beside the fleet's.
          // Totalling only the workers makes a fan-out look cheaper than it was;
          // the planning tokens are the leader's and they are not free.
          setLeaderCost(
            (c) => c + priceUsage(event.usage, session.agent.model, session.providerLabel).usd,
          );
          break;
        case "context_compacted":
          push({
            kind: "system",
            text: `✓ context compacted: ${event.before} → ${event.after} messages${
              event.reason === "auto" ? " (auto)" : ""
            }`,
          });
          setCtxUsed(0);
          setCompactions((c) => ({
            count: c.count + 1,
            last: { before: event.before, after: event.after },
          }));
          break;
        case "autonomy_verify": {
          const what = event.scope && event.scope !== "goal" ? ` ${event.scope}` : "";
          const by = event.by ? ` (${event.by})` : "";
          if (!event.pass) {
            // The items are the actionable half — the worker is about to be given
            // exactly these, so showing them makes the next attempt legible.
            const items = event.mustFix?.length
              ? `\n${event.mustFix.map((m) => `  • ${m}`).join("\n")}`
              : "";
            push({
              kind: "system",
              text: `✗ verification failed${by}${what}${
                event.attempt ? `, attempt ${event.attempt}` : ""
              }${event.note ? ` — ${event.note}` : ""}${items}`,
            });
          } else if (event.skipped) {
            // "Unverified" is not "verified". A green check here would be a lie,
            // and this line is what makes an unreachable verifier visible at all.
            push({
              kind: "system",
              text: `⚠ verification unavailable — accepting the claim${
                event.note ? ` (${event.note})` : ""
              }`,
            });
          } else {
            push({
              kind: "system",
              text: `✓ verified${by}${what}${event.note ? ` — ${event.note}` : ""}`,
            });
          }
          break;
        }
        case "tool_results_cleared":
          push({
            kind: "system",
            text: `✓ context: ${event.cleared} stale tool result${event.cleared > 1 ? "s" : ""} cleared`,
          });
          setClearedResults((n) => n + event.cleared);
          break;
        case "autonomy_resume_available":
          push({
            kind: "system",
            text: `⏸ unfinished goal from the resumed session (${event.mode}, step ${event.step}): "${event.goal}" — relaunch with /goal ${event.goal}`,
          });
          break;
        case "run_limit":
          push({
            kind: "system",
            text:
              event.kind === "iterations"
                ? `⚠ turn stopped: iteration cap reached (${event.limit}) — the reply may be unfinished; send a message to continue`
                : `⚠ turn stopped: token budget spent (${event.used}/${event.limit}) — send a message to continue`,
          });
          break;
        // The guards, made visible. Each of the next six events was emitted by
        // core and handled nowhere here, so the terminal showed a run that
        // paused, repeated itself, was granted more steps, or refused to send a
        // request — with no line to say why. The desktop bridge read them; the
        // TUI, which is where an attended run is actually watched, did not.
        case "loop_detected":
          // A steer was injected, not a stop: say what the loop was and that
          // the run continues, or this reads as a failure.
          push({
            kind: "system",
            text: `↻ looping: the same step ran ${event.streak}× — steered (${event.note})`,
          });
          break;
        case "loop_cut":
          push({
            kind: "system",
            text: `■ turn cut: the same step repeated ${event.streak}× without progress`,
          });
          break;
        case "autonomy_extended":
          // The step cap is a progress gate, not a wall. Without this line a
          // run that should have stopped at the cap silently keeps going.
          push({
            kind: "system",
            text: `▸ step cap extended to ${event.newLimit} — ${event.reason}`,
          });
          break;
        case "budget_warning":
          push({
            kind: "system",
            text: `⚠ budget: ${event.spent} spent — wrapping up`,
          });
          break;
        case "budget_exceeded":
          // The request was refused before it was sent, so nothing else on
          // screen will change. This line is the only evidence of the refusal.
          push({
            kind: "system",
            text: `✗ budget exhausted (${event.spent}) — the request was refused before it was sent`,
          });
          break;
        case "autonomy_backoff":
          push({
            kind: "system",
            text: `◷ provider error — retrying in ${(event.ms / 1000).toFixed(event.ms < 10_000 ? 1 : 0)}s (attempt ${event.attempt})`,
          });
          break;
        case "autonomy_journal":
          // One line per eternal step, most of them `ok`. Printing all of them
          // would bury the transcript in a status the screen already shows;
          // the ones worth a line are the steps that did not go well.
          if (event.status !== "ok" && event.status !== "idle") {
            push({ kind: "system", text: `⚠ step ${event.status}: ${event.note}` });
          }
          break;
        case "team_message":
          // A member's `result` is its round recap, which the board and the
          // round summary already carry. A directed `message` is the one thing
          // with no other home: one worker deliberately telling another
          // something, invisible until now.
          if (event.kind === "message") {
            push({
              kind: "system",
              text: `✉ ${event.fromName} → ${event.toName ?? "team"}: ${oneLine(event.text, 120)}`,
              // The sender's own accent, the same one its board cell and its
              // permission prompt wear — a fan-out is only readable if one
              // worker is one colour everywhere.
              color: agentColor(event.from),
            });
          }
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
        case "permission_request":
          // Arrives synchronously just before the broker calls our asker; the ref
          // is what the prompt reads for its "⚑ worker" line. A main-agent request
          // carries no origin, which clears the previous one.
          permOriginRef.current = event.origin;
          // A blocked worker's board row should say so — otherwise the row just
          // sits on its last tool call while the whole fan-out waits.
          if (event.origin?.id) {
            const id = event.origin.id;
            permRowRef.current = id;
            setTeamMembers((prev) =>
              prev.map((m) => (m.id === id ? { ...m, activity: "⊙ awaiting permission" } : m)),
            );
          }
          break;
        case "permission_queued":
          setPermQueued(event.queued);
          break;
        case "permission_resolved":
          // Hand the row back to its tool: the sub-agent's next event may be a
          // while away (the call it just got cleared to make), and leaving
          // "awaiting permission" up would read as still blocked.
          if (permRowRef.current) {
            const id = permRowRef.current;
            permRowRef.current = undefined;
            const activity = event.answer === "deny" ? "⊘ denied" : `⚙ ${event.tool}`;
            setTeamMembers((prev) => prev.map((m) => (m.id === id ? { ...m, activity } : m)));
          }
          // A prompt answered from the desktop tears itself down here with no
          // keypress of yours — say so, or its disappearance reads as a glitch.
          if (event.via === "remote") {
            push({
              kind: "system",
              text: `⊙ ${event.tool}: ${PERMISSION_ANSWER_LABEL[event.answer]} from the desktop`,
            });
          }
          break;
        case "subagent_start":
          push({
            kind: "system",
            text: `⟳ sub-agent${event.role ? ` (${event.role})` : ""}: ${oneLine(event.task, 80)}`,
            color: agentColor(event.id ?? event.role ?? "sub-agent"),
          });
          break;
        case "subagent_done":
          push({
            kind: "system",
            text: `↩ sub-agent${event.role ? ` (${event.role})` : ""} done: ${oneLine(
              event.output,
              120,
            )}`,
            color: agentColor(event.id ?? event.role ?? "sub-agent"),
          });
          break;
        case "fleet_start":
          push({ kind: "system", text: `⛓ dispatching ${event.count} sub-agents in parallel…` });
          // A bare `spawn_parallel` ships its rows here (nothing planned a round
          // for it), so the board — and its ^↑↓ / ⏎ navigation — comes up for a
          // plain fan-out too, not just /team and parallel autonomy.
          //
          // An /sdd wave never lands here: it carries the graph's task ids, so the
          // fleet counts it as planned and ships no rows. That is deliberate — the
          // kanban already has a row per task, and a second board for the same wave
          // would say nothing new while printing each worker's whole prompt.
          if (event.tasks && event.tasks.length > 0) {
            setBoardKind("fleet");
            setTeamMembers(
              event.tasks.map((t) => ({
                id: t.id,
                name: t.role ?? "subtask",
                description: t.task,
                adhoc: false,
                state: "pending" as const,
              })),
            );
            setTeamSel(0);
            setTeamDetailOpen(false);
            setTeamFeeds(new Map());
          }
          break;
        case "fleet_done":
          push({ kind: "system", text: `⛓ fleet complete (${event.count} done)` });
          break;
        case "autonomy_fleet_round": {
          push({
            kind: "system",
            text: `◆ round ${event.round}: dispatching ${event.tasks.length} subtask(s)`,
          });
          // Seed the board with this round's subtasks so ↑↓/⏎ can inspect them
          // live, exactly as in team mode. Only parallel and phased runs emit
          // this event (a team run seeds from `team_plan`, whose roster stands
          // across rounds), so replacing the rows wholesale is safe here.
          {
            const rows = event.tasks.filter(
              (t): t is { id: string; task: string; role?: string } => typeof t.id === "string",
            );
            if (rows.length > 0) {
              setBoardKind("fleet");
              setTeamMembers(
                rows.map((t) => ({
                  id: t.id,
                  name: t.role ?? "subtask",
                  description: t.task,
                  adhoc: false,
                  state: "pending" as const,
                })),
              );
              setTeamSel(0);
              setTeamDetailOpen(false);
              setTeamFeeds(new Map());
            }
          }
          break;
        }
        case "autonomy_aggregate":
          push({
            kind: "system",
            text: `◆ round ${event.round} aggregated (${event.count} result(s))`,
          });
          break;
        case "team_plan":
          // Seed the live member board; the transcript keeps a one-line roster record.
          setBoardKind("team");
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
                    // Stamped once, on the way IN to running, and then kept:
                    // a finished cell should still say how long it took, and
                    // re-stamping on a later state event would reset the clock
                    // of a member that never stopped working.
                    startedAt:
                      event.state === "running" ? (m.startedAt ?? Date.now()) : m.startedAt,
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
              color: event.state === "failed" ? "red" : agentColor(event.id),
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
          // The member's own telemetry, bridged off its private bus: tokens
          // billed, context filled, tool calls made. Activity alone said what a
          // worker was DOING; none of it said how close it was to the wall it
          // would hit, which is what decides whether its answer is worth
          // reading. `window` is optional on the event (a local model the
          // catalog doesn't know), so the session's own window is the fallback.
          if (activity || RICH.has(inner.type)) {
            setTeamMembers((prev) =>
              prev.map((m) => {
                if (m.id !== event.id) return m;
                const next = { ...m };
                if (activity) next.activity = activity;
                if (inner.type === "tool_call") next.steps = (m.steps ?? 0) + 1;
                if (inner.type === "usage") {
                  // Prompt + completion: each iteration re-bills the prompt, so
                  // the sum is the real spend (same definition as turnTokenBudget).
                  next.tokens =
                    (m.tokens ?? 0) +
                    (inner.usage.promptTokens ?? 0) +
                    (inner.usage.completionTokens ?? 0);
                  // Priced through core's own function, so a worker's cell and
                  // the run's budget can never disagree about what a token
                  // costs. A worker runs the session's model — the fleet does
                  // not assign its own — so that is what it is priced at, and
                  // an unpriced (local, unlisted) model simply adds nothing.
                  next.cost =
                    (m.cost ?? 0) +
                    priceUsage(inner.usage, session.agent.model, session.providerLabel).usd;
                }
                if (inner.type === "context_usage") {
                  next.ctxUsed = inner.used;
                  next.ctxWindow =
                    inner.window ??
                    m.ctxWindow ??
                    session.agent.effectiveContextWindow() ??
                    DEFAULT_CTX;
                }
                return next;
              }),
            );
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
        case "team_memory":
          // A note a member left its future self. It belongs to that member,
          // not to the run, so it goes in the member's feed rather than the
          // transcript — the drill-down is where "what was this worker
          // thinking" is actually asked.
          setTeamFeeds((prev) => {
            const next = new Map(prev);
            next.set(event.member, appendFeed(prev.get(event.member), `✎ note: ${event.text}`));
            return next;
          });
          break;
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
            text: `■ /sdd complete — ${event.done} done, ${event.failed} failed${
              event.blocked ? `, ${event.blocked} blocked` : ""
            }`,
          });
          break;
        case "error":
          // Tag the failure class when the provider supplied one, so "quota" and
          // "auth" are distinguishable at a glance instead of by reading the body.
          push({
            kind: "system",
            text: event.kind ? `error [${event.kind}]: ${event.error}` : `error: ${event.error}`,
          });
          break;
        case "provider_fallback":
          push({
            kind: "system",
            text: `↪ ${event.from.provider}/${event.from.model} ${event.reason} — falling back to ${event.to.provider}/${event.to.model}`,
          });
          setFallbackTo({ provider: event.to.provider, model: event.to.model });
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
      if (!visibleRef.current) return;
      if (!key.escape || pendingRef.current) return;
      // Closing a view the user opened comes before stopping work they did not
      // ask to stop — Esc on an open panel must never abort the turn behind it.
      if (contextOpenRef.current) {
        setContextOpen(false);
        return;
      }
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
      setFallbackTo(null);
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
        setFallbackTo(null);
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
      // An explicit mode choice always leaves AUTONOMOUS first — keeping the
      // goal-launcher armed under a freshly chosen ASK would betray the badge.
      if (autoArmed && session.setAutonomous) {
        for (const text of session.setAutonomous(false)) push({ kind: "system", text });
        setAutoArmed(false);
      }
      session.setMode(next);
      setPermMode(next);
      push({ kind: "system", text: `▸ permission mode → ${next.toUpperCase()}` });
    },
    [session, push, autoArmed],
  );

  /**
   * Arm/disarm autonomous mode (Shift+Tab past PLAN). All policy lives behind
   * `session.setAutonomous` (injected by the CLI); the TUI only owns the
   * gesture and the badge. Returns false when the session can't do it, so the
   * cycle can fall through to ASK instead of trapping the user on PLAN.
   */
  const setAutonomous = useCallback(
    (on: boolean): boolean => {
      if (!session.setAutonomous) return false;
      const lines = session.setAutonomous(on);
      setAutoArmed(on);
      setPermMode(on ? "yolo" : "ask");
      for (const text of lines) push({ kind: "system", text });
      return true;
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
        setFallbackTo(null);
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
          setFallbackTo(null);
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
    {
      isActive: visible && status === "idle" && !pickerOpen && !loginOpen && !pending && !interview,
    },
  );

  // Shift+Tab cycles ASK → AUTO → PLAN → AUTONOMOUS → ASK. The last slot is
  // not a permission mode: it arms the unattended profile on the live session
  // and routes plain prompts into the autonomy engine.
  useInput(
    (_input, key) => {
      if (key.tab && key.shift) {
        if (autoArmed) {
          setAutonomous(false);
          return;
        }
        if (permMode === "plan" && setAutonomous(true)) return;
        const i = MODE_CYCLE.indexOf(permMode);
        applyMode(MODE_CYCLE[(i + 1) % MODE_CYCLE.length] ?? "ask");
      }
    },
    {
      isActive: visible && status === "idle" && !pickerOpen && !loginOpen && !pending && !interview,
    },
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
    { isActive: visible && pickerOpen },
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
    { isActive: visible && loginOpen },
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
    { isActive: visible && interview !== null },
  );

  const handleSlash = useCallback(
    async (raw: string): Promise<void> => {
      const [cmd, ...rest] = raw.slice(1).trim().split(/\s+/);
      // The verbatim remainder after the command word. `rest.join(" ")` collapses
      // every run of whitespace, which silently destroys the line structure of a
      // pasted multi-line goal — and a `verify: <cmd>` marker only counts when it
      // opens a line. Free-text commands take this; option-parsing ones keep `rest`.
      const body = raw
        .slice(1)
        .trim()
        .slice(cmd?.length ?? 0)
        .trim();
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
          setBoardKind("team");
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
        case "context": {
          // Opened, not printed: the composition is a live view that has to
          // survive the next turn changing it. The breakdown is measured on
          // open (it reads the project instructions off disk to price the
          // system prompt) and refreshed whenever the panel is reopened.
          setContextBreakdown(undefined);
          setContextOpen(true);
          void session.agent
            .contextBreakdown()
            .then(setContextBreakdown)
            .catch(() => setContextBreakdown(undefined));
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
        case "permissions": {
          if (!session.permissionsTable) {
            push({ kind: "system", text: "permissions table unavailable in this session" });
            break;
          }
          // `/permissions [mode] [outcome]` — both optional, order-free, since
          // "plan" and "deny" can't be confused for each other.
          const args = rest.join(" ").trim().toLowerCase().split(/\s+/).filter(Boolean);
          const mode = args.find((a) => (PERMISSION_MODES as string[]).includes(a));
          const only = args.find((a) => ["allow", "deny", "prompt"].includes(a));
          const unknown = args.find((a) => a !== mode && a !== only);
          if (unknown) {
            push({
              kind: "system",
              text: `unknown argument "${unknown}" — usage: /permissions [ask|auto|plan|yolo] [allow|deny|prompt]`,
            });
            break;
          }
          try {
            push({
              kind: "system",
              text: session.permissionsTable({
                ...(mode ? { mode: mode as PermissionMode } : {}),
                ...(only ? { only } : {}),
              }),
            });
          } catch (err) {
            push({ kind: "system", text: `permissions: ${(err as Error).message}` });
          }
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
          const g = body;
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
          const modeArg = rest[0] ?? "";
          const mode = modeArg.toLowerCase();
          const modes: AutonomyMode[] = ["once", "eternal", "parallel", "phased", "team"];
          const g = body.slice(modeArg.length).trim();
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
          const g = body;
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
          // Copy via OSC 52 — the terminal owns the clipboard write, so this
          // works over SSH too, and it reaches text no selection can: replies
          // longer than the screen, and (with `all`) the whole conversation.
          // `/copy` = last reply; `/copy all` = every user+assistant message.
          const wantAll = rest[0] === "all";
          const last = [...items].reverse().find((i) => i.kind === "assistant");
          const text = wantAll
            ? items
                .filter((i) => i.kind === "user" || i.kind === "assistant")
                .map((i) => (i.kind === "user" ? `› ${i.text}` : i.text))
                .join("\n\n")
            : last && last.kind === "assistant"
              ? last.text
              : "";
          if (!text) {
            push({ kind: "system", text: "nothing to copy yet — no conversation" });
          } else {
            // OS helper first on a local TTY, OSC 52 as the fallback — the
            // terminal this app ships in drops OSC 52 silently, and a /copy
            // that "worked" while the clipboard stayed empty is worse than an
            // honest failure. The method lands in the message so a broken
            // route is visible, not guessed.
            const method = await copyToClipboard(text, {
              ...(rawStdout ? { stdout: rawStdout } : {}),
              tty: process.stdout.isTTY === true,
            });
            if (method === "none") {
              push({ kind: "system", text: "clipboard unavailable (no helper, no terminal)" });
            } else {
              const clipped =
                text.length > OSC52_MAX_CHARS ? ` — clipped to first ${OSC52_MAX_CHARS}` : "";
              push({
                kind: "system",
                text: `⧉ copied ${wantAll ? "the conversation" : "the last reply"} to the clipboard (${text.length} chars${clipped} · ${method})`,
              });
            }
          }
          break;
        }
        case "rewind":
        case "redo": {
          // Undo what the agent wrote, per turn. The list is the picker: no
          // argument prints it, an index restores. What rewind CANNOT undo is
          // printed with it every time — a partial restore that looks total is
          // how people lose work they thought was recoverable.
          const store = session.checkpoints;
          if (!store) {
            push({ kind: "system", text: "checkpoints are not available in this session" });
            break;
          }
          if (cmd === "redo") {
            const target = store.redoTarget();
            if (!target) {
              push({ kind: "system", text: "nothing to redo — /rewind first" });
              break;
            }
            const res = await store.restore(target);
            push({ kind: "system", text: `↷ redone — ${restoreSummary(res)}` });
            break;
          }
          const list = await store.list();
          if (list.length === 0) {
            push({ kind: "system", text: "no checkpoints yet — they are recorded per turn" });
            break;
          }
          const which = rest[0];
          if (!which) {
            const rows = list
              .map(
                (c, i) =>
                  `  ${String(i + 1).padStart(2)}. ${new Date(c.ts).toLocaleTimeString()}  ` +
                  `${c.entries.length} file${c.entries.length === 1 ? "" : "s"}  ${c.label}`,
              )
              .join("\n");
            push({
              kind: "system",
              text: `↶ checkpoints (newest last) — /rewind <n> to restore\n${rows}\n${REWIND_LIMITS}`,
            });
            break;
          }
          const n = Number(which);
          const cp = Number.isInteger(n) ? list[n - 1] : undefined;
          if (!cp) {
            push({ kind: "system", text: `usage: /rewind <1-${list.length}>` });
            break;
          }
          const res = await store.restore(cp.id);
          push({
            kind: "system",
            text: `↶ rewound to before "${cp.label}" — ${restoreSummary(res)}\n${REWIND_LIMITS}`,
          });
          break;
        }
        case "limits": {
          const snap = session.rateLimits?.();
          if (!snap) {
            push({
              kind: "system",
              text: session.rateLimits
                ? "no rate-limit report yet — the provider sends limits with each reply, so ask something first"
                : "this session's provider does not report rate limits",
            });
          } else {
            push({
              kind: "system",
              text: [`◔ ${providerLabel} rate limits`, ...formatRateLimits(snap)].join("\n"),
            });
          }
          break;
        }
        case "mouse": {
          // Runtime escape hatch for "I just want to select and copy some
          // text": capture owns drag events for in-app wheel scroll, so plain
          // selection needs it OFF (Shift+drag bypasses it while ON). Runtime
          // only — `tui.mouse: false` is the persistent form.
          if (!onToggleMouse) {
            push({
              kind: "system",
              text: mouseCapture
                ? "mouse capture is fixed here — use Shift+drag to select, or set tui.mouse: false"
                : "mouse is not captured — drag already selects text",
            });
          } else {
            const on = onToggleMouse();
            push({
              kind: "system",
              text: on
                ? "▸ mouse capture ON — wheel scrolls in-app; select text with Shift+drag"
                : "▸ mouse capture OFF — drag selects text; /mouse again to re-capture the wheel",
            });
          }
          break;
        }
        case "sdd": {
          const skipInterview = /(^|\s)--yes\b/.test(` ${body}`);
          const brief = body.replace(/(^|\s)--yes\b/g, "").trim();
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
          const note = body;
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
      mouseCapture,
      onToggleMouse,
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
      // AUTONOMOUS armed and idle: the prompt IS the goal — hand it to the
      // engine instead of running a supervised single turn. (While a goal is
      // running the steering branch above already owns plain text.)
      if (autoArmed) {
        push({ kind: "user", text });
        void session.autonomy.start(text);
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
    [session, handleSlash, push, runPlain, autoArmed],
  );

  // First message of a panel-created session (mirror of initialGoal, one-shot).
  const initialPromptSentRef = useRef(false);
  useEffect(() => {
    if (!initialPrompt || initialPromptSentRef.current) return;
    initialPromptSentRef.current = true;
    void dispatch(initialPrompt);
  }, [initialPrompt, dispatch]);

  // Background-session badge: tell the host when a permission prompt is waiting.
  useEffect(() => {
    onPendingChange?.(pending !== null);
  }, [pending, onPendingChange]);

  // Multi-session keys: plain ← opens the session panel (the prompt editor is
  // append-only, so ← is not cursor movement); Ctrl+←/→ cycle sessions directly;
  // Ctrl+X closes this session (Ctrl+C stays "quit the whole CLI").
  useInput(
    (input, key) => {
      if (key.ctrl && (input === "x" || input === "X")) {
        onCloseSession?.();
        return;
      }
      if (!key.leftArrow && !key.rightArrow) return;
      if (key.ctrl) {
        onCycleSession?.(key.leftArrow ? -1 : 1);
        return;
      }
      if (key.leftArrow && !key.meta && !key.shift) onOpenSessions?.();
    },
    {
      isActive:
        visible && !pickerOpen && !loginOpen && !pending && !interview && teamSuggest === null,
    },
  );

  // The one place the board selection moves from — shared by the key handler
  // below and (in fullscreen) by the arrow router. Reads the row count through a
  // ref, so it can never wrap against a stale one.
  const stepMember = useCallback((d: number) => {
    const count = memberCountRef.current;
    if (count === 0) return;
    setTeamSel((s) => (Math.min(s, count - 1) + d + count) % count);
  }, []);

  // Board keys, in order of how reliably a terminal transmits them:
  //
  //   ⇥ (Tab)      — steps to the next row while a board is up, unless the prompt
  //                  has a slash-completion to offer (that keeps Tab). A bare
  //                  0x09: no terminal can mangle it, so this is the one binding
  //                  that always works. Wired through InputLine's `onTab`, not
  //                  here — see the note on that prop.
  //   Ctrl+↑/↓     — CSI "1;5A/B". Some terminals (Konsole among them) drop the
  //                  modifier and send a plain arrow instead, which is why Tab and
  //                  Alt exist below.
  //   Alt+↑/↓      — ESC-prefixed arrow, transmitted where Ctrl+arrow isn't.
  //   ↑/↓          — while a drill-down feed is open, inspecting IS the mode, so
  //                  the bare arrows step rows there too. With the feed closed they
  //                  stay prompt history, whatever the board is doing.
  //
  // All wrap at the ends. Shift+Tab is left alone — it cycles the permission mode.
  //
  // The plain-arrow branch is skipped when the arrow ROUTER owns arrows
  // (fullscreen without mouse capture): there the terminal turns wheel ticks into
  // arrow sequences, so a scroll would drag the selection along. That path steps
  // the row from `arrowHistoryRef` below instead, after the router has classified
  // the arrow as a keypress.
  useInput(
    (_input, key) => {
      if (memberCountRef.current === 0) return;
      const step = stepMember;
      const plainArrows = teamDetailOpenRef.current && !routedArrowsRef.current;
      if ((key.ctrl || key.meta) && key.upArrow) step(-1);
      else if ((key.ctrl || key.meta) && key.downArrow) step(1);
      else if (plainArrows && key.upArrow && !key.shift) step(-1);
      else if (plainArrows && key.downArrow && !key.shift) step(1);
    },
    {
      isActive:
        visible && !pickerOpen && !loginOpen && !pending && !interview && teamSuggest === null,
    },
  );

  const submit = useCallback(
    async (value: string) => {
      const text = value.trim();
      setInput("");
      if (!text) {
        // Enter on an empty prompt toggles the selected row's drill-down view —
        // a team member's, or an /sdd task's on the kanban.
        // Read through the ref: `submit` is memoized, and a fresh `boardRows`
        // array every render would either stale the closure or defeat the memo.
        if (memberCountRef.current > 0) setTeamDetailOpen((v) => !v);
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
    [session, dispatch],
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
    { isActive: visible && teamSuggest !== null },
  );

  // Up/Down always recall previously submitted prompts (shell-style history).
  // A visible board never shadows them — member selection lives on Ctrl+↑/↓ and
  // on Tab while a drill-down is open (see the board-navigation hook above).
  const onHistoryPrev = (): void => {
    const { nav, value } = historyUp(history, input);
    setHistory(nav);
    setInput(value);
  };
  const onHistoryNext = (): void => {
    const { nav, value } = historyDown(history, input);
    setHistory(nav);
    setInput(value);
  };

  const busy = status !== "idle";
  // AUTONOMOUS is not a permission mode but it owns the badge while armed —
  // the underlying yolo would be the misleading label here.
  const mode = autoArmed ? "AUTONOMOUS" : permMode.toUpperCase();

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
    // An open drill-down owns the arrows: the router has already ruled this one a
    // keypress rather than a wheel tick, so stepping the row here is safe.
    if (teamDetailOpen && boardRows.length > 0) {
      stepMember(dir === "up" ? -1 : 1);
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
      {sddTasks.length > 0 ? (
        <SddBoard
          tasks={sddTasks}
          columns={columns}
          // Only one board is navigable at a time, and a /team roster wins — an
          // /sdd run raises no roster, so in practice this is the kanban's.
          selected={teamMembers.length > 0 ? -1 : teamSel}
          detailOpen={teamMembers.length === 0 && teamDetailOpen}
          feed={teamFeeds.get(sddTasks[Math.min(teamSel, sddTasks.length - 1)]?.id ?? "") ?? []}
        />
      ) : null}
      {teamMembers.length > 0 ? (
        <TeamBoard
          members={teamMembers}
          columns={columns}
          selected={teamSel}
          detailOpen={teamDetailOpen}
          feed={
            teamFeeds.get(teamMembers[Math.min(teamSel, teamMembers.length - 1)]?.id ?? "") ?? []
          }
          kind={boardKind}
          now={swarmClock}
          leader={{ cost: leaderCost }}
        />
      ) : null}
      {contextOpen ? (
        <ContextPanel
          used={ctxUsed}
          window={ctxWindowLive ?? session.agent.effectiveContextWindow() ?? DEFAULT_CTX}
          estimated={ctxEstimated}
          breakdown={contextBreakdown}
          compactAt={session.config.context.compactAtPercent ?? 0.75}
          compactions={compactions}
          cleared={clearedResults}
          members={teamMembers}
          columns={columns}
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
        <PermissionPrompt pending={pending} queued={permQueued} />
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
          {/* The "working" line used to live here. It is on the composer's top
              rail now: the turn runs behind a LIVE prompt, so the spinner
              belongs where the eye already is, and the row it used to take is
              a row the transcript keeps. */}
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
            active={visible && !teamSuggest}
            value={input}
            commands={COMMANDS}
            columns={columns}
            // The frame makes "where do I type" visible; its color mirrors the
            // mode badge (magenta while AUTONOMOUS is armed, red under yolo).
            borderColor={
              autoArmed
                ? theme.monitor.swarm
                : permMode === "yolo"
                  ? theme.error
                  : theme.borderDefault
            }
            // The turn's clock lives on the frame's top rail now, so liveness
            // sits where the eye already is instead of on a line of its own.
            workingSince={busy && autoState === "idle" ? turnStartRef.current : undefined}
            hint={
              busy && autoState === "idle"
                ? "Esc cancels · Enter queues the next message"
                : "Enter send · ? help · ↑↓ history · Esc cancels"
            }
            onChange={setInput}
            onSubmit={submit}
            onHelp={() => push({ kind: "help" })}
            onHistoryPrev={onHistoryPrev}
            onHistoryNext={onHistoryNext}
            // Tab with nothing to complete steps the board (no-op without rows).
            onTab={() => stepMember(1)}
            // App owns ↑/↓ in two cases: the fullscreen arrow router, and an open
            // board drill-down (where they step rows instead of recalling history).
            externalArrows={routedArrows || (teamDetailOpen && boardRows.length > 0)}
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
        sessions={sessionsBadge}
        fallbackTo={fallbackTo}
        version={version}
      />
    </>
  );

  // Multi-session: a hidden App stays mounted (every hook above keeps running —
  // bus subscription, queue drain, token counters) but renders nothing.
  if (!visible) return null;

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
