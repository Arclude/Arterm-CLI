import {
  type AutonomyMode,
  type ModelInfo,
  PERMISSION_MODES,
  type PermissionAsker,
  type PermissionMode,
  fetchCatalog,
  searchCatalog,
  toolCallPreview,
} from "@arterm/core";
import { Box, type DOMElement, Text, measureElement, useApp, useInput, useStdout } from "ink";
import type React from "react";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { LoginOverlay } from "./LoginOverlay.js";
import { Item } from "./MessageList.js";
import { ModelPicker } from "./ModelPicker.js";
import { type PendingPermission, PermissionPrompt } from "./PermissionPrompt.js";
import { type Status, StatusBar } from "./StatusBar.js";
import {
  type HistoryNav,
  commandSuggestion,
  emptyHistory,
  historyDown,
  historyPush,
  historyUp,
  reduceInput,
} from "./editing.js";
import type { DisplayItem, LoginProvider, Session } from "./types.js";

/** Soft context-window estimate for the status-bar gauge (local models rarely report one). */
const DEFAULT_CTX = 32768;

const HELP = [
  "Commands (type and press Enter):",
  "  /help                 show this help        (or press ? )",
  "  /model                open the model picker (or press Alt+P)",
  "  /model <name|N>       switch model directly",
  "  /models               open the model picker (type to filter)",
  "  /login                sign in to a provider (pick provider + API key)",
  "  /catalog [query]      search the models.dev catalog (~5k models)",
  "  /clear                reset the conversation",
  "  /goal <text>          run autonomously toward a goal (decide→act→reflect→repeat)",
  "  /autonomy <mode> <goal>  run a goal in once | eternal | parallel | phased mode",
  "  /sdd <brief>          spec-driven dev: spec → task graph → parallel execution",
  "  /steer <text>         redirect the running goal · /pause /resume /stop",
  "  /compact              shrink the conversation context (auto when near full)",
  "  /mcp                  list connected MCP servers and their tools",
  "  /plugins              list loaded plugins (with trust + gating)",
  "  /skills · /skill <n>  list skills · run a skill by name",
  "  /mode [ask|auto|plan|yolo]  set permission mode (no arg cycles)",
  "  /auto /plan /ask /yolo      shortcuts for /mode",
  "  /exit                 quit (or Ctrl+C)",
  "Keys:  Enter send · ↑/↓ recall your previous prompts (input history) · Shift+Tab cycle mode · Alt+P models · Esc cancel · Ctrl+C quit",
  "Scroll: the mouse wheel scrolls the chat in-app. Plain ↑/↓ recall your previous prompts (input history), not scroll.",
  "Modes: ASK prompts · AUTO auto-approves edits · PLAN read-only · YOLO approves all",
  "Edit:  Backspace del char · Ctrl+W del word · Ctrl+U clear line",
].join("\n");

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
}): React.ReactElement {
  const suggestion = commandSuggestion(value, commands);
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
      // Tab completes a slash command to its first match. Shift+Tab is the
      // permission-mode cycle, handled in App — fall through and leave it.
      if (key.tab && !key.shift) {
        if (suggestion) onChange(value + suggestion);
        return;
      }
      const action = reduceInput(value, input, key);
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
  "goal",
  "autonomy",
  "sdd",
  "steer",
  "pause",
  "resume",
  "stop",
  "compact",
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
 * Managed, in-app scrollable transcript (replaces Ink's <Static>). Mouse reporting
 * captures the wheel, so the chat can no longer ride the terminal's native scrollback
 * — we scroll it ourselves. Technique (Ink-5, mirrors WrongStack's ScrollableHistory):
 * a height-bounded `overflowY:"hidden"` + `justifyContent:"flex-end"` viewport bottom-
 * aligns the content, so overflow clips off the TOP (newest visible) for free; a
 * positive `marginBottom={scrollOffset}` then lifts the content to reveal older rows.
 * (Negative marginTop does NOT clip reliably — it overlaps; do not use it.)
 *
 * Wrapped in React.memo so keystrokes in the prompt don't re-lay-out the whole
 * transcript — only items/live/viewport/offset changes do.
 */
const Transcript = memo(function Transcript({
  items,
  live,
  viewportRows,
  marginBottom,
  columns,
  onMeasure,
}: {
  items: DisplayItem[];
  live: string;
  viewportRows: number;
  marginBottom: number;
  columns: number;
  /** Reports the measured content height (rows) after each layout, so App can clamp
   *  the scroll offset and keep the view anchored as content streams in. */
  onMeasure: (totalLines: number) => void;
}): React.ReactElement {
  const contentRef = useRef<DOMElement>(null);
  const lastReported = useRef(-1);
  // The content's own height does not depend on viewportRows/marginBottom (margins
  // and justify are layout-outside), so measuring here never feeds back into a loop.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure on content change
  useLayoutEffect(() => {
    const node = contentRef.current;
    if (!node) return;
    const { height } = measureElement(node);
    if (height !== lastReported.current) {
      lastReported.current = height;
      onMeasure(height);
    }
  }, [items, live, columns, onMeasure]);

  return (
    <Box
      width={columns}
      height={Math.max(1, viewportRows)}
      overflowY="hidden"
      justifyContent="flex-end"
      flexDirection="column"
    >
      <Box
        ref={contentRef}
        flexDirection="column"
        marginBottom={Math.max(0, marginBottom)}
        flexShrink={0}
      >
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
            <Text>{live}</Text>
          </Box>
        ) : null}
      </Box>
    </Box>
  );
});

export function App({
  session,
  initialGoal,
}: {
  session: Session;
  initialGoal?: string;
}): React.ReactElement {
  const { exit } = useApp();
  const { rows, columns } = useTermSize();
  const [items, setItems] = useState<DisplayItem[]>([]);
  const [status, setStatus] = useState<Status>("idle");
  // In-app transcript scrolling (see the Transcript component). `scrollOffset` is how
  // many lines the view is lifted off the bottom (0 = pinned to newest). The mouse
  // wheel drives it; ↑/↓ stay on prompt history. `totalLines`/`viewportRows` are
  // measured so the offset can be clamped and the content kept put as it streams.
  const [scrollOffset, setScrollOffset] = useState(0);
  const [totalLines, setTotalLines] = useState(0);
  const [viewportRows, setViewportRows] = useState(() => Math.max(1, rows - 8));
  const bottomRef = useRef<DOMElement>(null);
  const viewportRef = useRef(viewportRows);
  const prevContentRef = useRef(0);
  const maxOffsetRef = useRef(0);
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
  const [loginStep, setLoginStep] = useState<"provider" | "key">("provider");
  const [loginIndex, setLoginIndex] = useState(0);
  const [loginSel, setLoginSel] = useState<LoginProvider | null>(null);
  const [loginKey, setLoginKey] = useState("");
  const [signedIn, setSignedIn] = useState<string[]>(() => session.signedInProviders());
  const filteredPickerModels = useMemo(() => {
    const q = pickerQuery.trim().toLowerCase();
    return q ? pickerModels.filter((m) => m.name.toLowerCase().includes(q)) : pickerModels;
  }, [pickerModels, pickerQuery]);

  const abortRef = useRef<AbortController | null>(null);
  const turnStartRef = useRef(0);
  const turnRef = useRef({ inTok: 0, outTok: 0, rounds: 0 });

  const push = useCallback((item: DisplayItem) => setItems((prev) => [...prev, item]), []);

  // Stop the mouse wheel from recalling old prompts. On Windows Terminal a console
  // app reading input has the wheel translated into ↑/↓ arrow keys, which the prompt
  // reads as command-history navigation. Enabling SGR mouse reporting (1000 = button
  // events, 1006 = SGR coords) makes the terminal send real mouse sequences instead
  // of fake arrows — those are swallowed in reduceInput, so the wheel stays inert and
  // only genuine ↑/↓ keypresses recall history. Scroll the chat with Shift+wheel or
  // Ctrl+Shift+↑/↓ (these bypass the app's mouse capture in Windows Terminal).
  const { stdout: rawStdout } = useStdout();
  useEffect(() => {
    if (!rawStdout) return;
    const ESC = String.fromCharCode(27);
    rawStdout.write(`${ESC}[?1007l${ESC}[?1000h${ESC}[?1006h`);
    return () => {
      rawStdout.write(`${ESC}[?1000l${ESC}[?1006l${ESC}[?1007h`);
    };
  }, [rawStdout]);

  // Viewport height = terminal rows − the measured bottom region (input + overlays +
  // goal + status bar). Runs every commit (no deps) so it self-corrects as the bottom
  // region grows/shrinks; only dispatches when the value actually changes.
  useLayoutEffect(() => {
    if (!bottomRef.current) return;
    const { height } = measureElement(bottomRef.current);
    const vp = Math.max(1, rows - height);
    viewportRef.current = vp;
    setViewportRows((cur) => (cur === vp ? cur : vp));
  });

  // Receives the transcript's measured height from <Transcript>. When content grows
  // while the user is scrolled up, bump the offset by the growth so their view stays
  // anchored (instead of jumping); when pinned (offset 0) it stays at the bottom.
  // Stable identity (reads refs only) so it doesn't thrash the memoized Transcript.
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

  // Mouse wheel scrolls the transcript. With mouse reporting on, the wheel arrives as
  // SGR mouse reports (button bit 64; low bits 0 = up, 1 = down) — a fast scroll batches
  // several into one chunk, so sum them. reduceInput separately swallows these so they
  // never touch the prompt text.
  useInput(
    (input) => {
      let delta = 0;
      for (const mm of input.matchAll(/\[<(\d+);\d+;\d+[Mm]/g)) {
        const cb = Number(mm[1]);
        if ((cb & 64) === 0) continue; // not a wheel event
        const low = cb & 3;
        delta += low === 0 ? 3 : low === 1 ? -3 : 0; // up reveals older (+), down newer (−)
      }
      if (delta !== 0)
        setScrollOffset((o) => Math.max(0, Math.min(maxOffsetRef.current, o + delta)));
    },
    { isActive: true },
  );

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

  // Welcome banner (once).
  useEffect(() => {
    push({
      kind: "system",
      text: `Welcome to Arterm. Provider: ${session.providerLabel} · Model: ${session.agent.model}\n${HELP}`,
    });
  }, [session, push]);

  // Subscribe to agent events (once).
  useEffect(() => {
    return session.bus.on((event) => {
      switch (event.type) {
        case "turn_start":
          setStatus("thinking");
          setLive("");
          setScrollOffset(0); // jump to the newest output when a turn begins
          turnStartRef.current = Date.now();
          turnRef.current = { inTok: 0, outTok: 0, rounds: 0 };
          break;
        case "text_delta":
          // Accumulate streamed tokens for a live preview; replaced by the committed
          // assistant_message once the round finishes.
          setLive((s) => s + event.delta);
          break;
        case "assistant_message": {
          const text = event.message.content.trim();
          if (text) push({ kind: "assistant", text });
          setLive("");
          turnRef.current.rounds += 1;
          break;
        }
        case "tool_call":
          setStatus("tool");
          push({
            kind: "tool",
            name: event.call.name,
            args: JSON.stringify(event.call.arguments),
            diff: toolCallPreview(event.call.name, event.call.arguments) ?? undefined,
          });
          break;
        case "tool_result":
          push({
            kind: "tool",
            name: event.name,
            output: event.output,
            isError: event.isError,
            bytes: event.output.length,
            tok: Math.ceil(event.output.length / 4),
          });
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
          setGoalText("");
          push({ kind: "system", text: `✓ goal complete: ${event.summary}` });
          break;
        case "autonomy_stopped":
          setAutoState("idle");
          setGoalText("");
          push({ kind: "system", text: `■ autonomy stopped — ${event.reason}` });
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
          if (event.questions.length > 0) {
            push({ kind: "system", text: `? ${event.questions.join("\n? ")}` });
          }
          break;
        case "sdd_spec":
          push({
            kind: "system",
            text: `📄 spec written (${event.taskCount} task(s)): ${event.specPath}`,
          });
          break;
        case "sdd_graph":
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
        case "sdd_task_state": {
          const mark =
            event.state === "done"
              ? "✓"
              : event.state === "failed"
                ? "✗"
                : event.state === "running"
                  ? "▸"
                  : "·";
          push({ kind: "system", text: `${mark} ${event.id} ${event.title} — ${event.state}` });
          break;
        }
        case "sdd_done":
          push({
            kind: "system",
            text: `■ /sdd complete — ${event.done} done, ${event.failed} failed`,
          });
          break;
        case "error":
          push({ kind: "system", text: `error: ${event.error}` });
          break;
        case "turn_end":
          setStatus("idle");
          setLive("");
          push({
            kind: "stats",
            inTok: turnRef.current.inTok,
            outTok: turnRef.current.outTok,
            rounds: turnRef.current.rounds,
            ms: Date.now() - turnStartRef.current,
          });
          break;
      }
    });
  }, [session, push]);

  // Kick off an autonomous run if launched with --goal (start() guards re-entry).
  useEffect(() => {
    if (initialGoal) void session.autonomy.start(initialGoal);
  }, [initialGoal, session]);

  // Esc pauses an autonomous run, or cancels a manual turn.
  useInput(
    (_input, key) => {
      if (!key.escape) return;
      if (autoState === "running") session.autonomy.pause();
      else if (status !== "idle") abortRef.current?.abort();
    },
    { isActive: (status !== "idle" || autoState === "running") && !pending },
  );

  const openPicker = useCallback(async () => {
    setPickerOpen(true);
    setPickerLoading(true);
    setPickerQuery("");
    try {
      const models = await session.listAllModels();
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
  }, [session, push]);

  const choose = useCallback(
    (name: string) => {
      session.switchModel(name);
      setModel(name);
      push({ kind: "system", text: `✓ model → ${name}` });
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
        push({ kind: "system", text: `✓ ${session.providerLabel} / ${m.name}` });
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
          text: `✓ provider → ${p.id}${key ? " · key saved" : ""} — run /model to pick a model`,
        });
      } catch (err) {
        push({
          kind: "system",
          text: `✗ login failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    },
    [session, push],
  );

  // Alt+P (or Ctrl+P) opens the model picker.
  useInput(
    (input2, key) => {
      if ((key.meta || key.ctrl) && (input2 === "p" || input2 === "P")) void openPicker();
    },
    { isActive: status === "idle" && !pickerOpen && !loginOpen && !pending },
  );

  // Shift+Tab cycles the permission mode (ASK → AUTO → PLAN).
  useInput(
    (_input, key) => {
      if (key.tab && key.shift) {
        const i = MODE_CYCLE.indexOf(permMode);
        applyMode(MODE_CYCLE[(i + 1) % MODE_CYCLE.length] ?? "ask");
      }
    },
    { isActive: status === "idle" && !pickerOpen && !loginOpen && !pending },
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
          // No key needed, or already signed in → switch straight away using the
          // stored key. Otherwise collect a key first.
          if (!p.needsKey || signedIn.includes(p.id)) {
            switchTo(p);
            setLoginOpen(false);
          } else {
            setLoginSel(p);
            setLoginKey("");
            setLoginStep("key");
          }
        } else if (input2 === "r" && p?.needsKey) {
          // Replace a stored key: jump to key entry even if already signed in.
          setLoginSel(p);
          setLoginKey("");
          setLoginStep("key");
        } else if (input2 === "x" && p && signedIn.includes(p.id)) {
          // Forget this provider's stored key.
          session.removeApiKey(p.id);
          setSignedIn(session.signedInProviders());
        }
        return;
      }
      // step === "key": collect the secret, masked in the overlay.
      if (key.return) {
        if (loginSel && loginKey.trim()) switchTo(loginSel, loginKey.trim());
        setLoginOpen(false);
      } else if (key.backspace || key.delete) {
        setLoginKey((k) => k.slice(0, -1));
      } else if (input2 && !key.ctrl && !key.meta) {
        setLoginKey((k) => k + input2);
      }
    },
    { isActive: loginOpen },
  );

  const handleSlash = useCallback(
    async (raw: string): Promise<void> => {
      const [cmd, ...rest] = raw.slice(1).trim().split(/\s+/);
      switch (cmd) {
        case "help":
        case "?":
          push({ kind: "system", text: HELP });
          break;
        case "clear":
          session.agent.reset();
          setItems([]);
          setScrollOffset(0);
          setInTok(0);
          setOutTok(0);
          setCtxUsed(0);
          break;
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
          const modes: AutonomyMode[] = ["once", "eternal", "parallel", "phased"];
          const g = goalParts.join(" ").trim();
          if (!modes.includes(mode as AutonomyMode) || !g) {
            push({
              kind: "system",
              text: "usage: /autonomy <once|eternal|parallel|phased> <goal>",
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
        case "sdd": {
          const brief = rest
            .join(" ")
            .replace(/(^|\s)--yes\b/g, "")
            .trim();
          if (!brief) {
            push({ kind: "system", text: "usage: /sdd <brief>" });
          } else if (session.sdd.state === "running" || session.sdd.state === "paused") {
            push({ kind: "system", text: "an /sdd run is already active — /stop it first" });
          } else {
            push({ kind: "system", text: `▸ /sdd: planning "${brief}"…` });
            void session.sdd.run(brief);
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
          const servers = session.mcpServers;
          if (servers.length === 0) {
            push({
              kind: "system",
              text: "no MCP servers configured — add them to ~/.arterm/config.json → mcpServers",
            });
          } else {
            const lines = servers.map((s) =>
              s.status === "connected"
                ? `  ✓ ${s.name} — ${s.toolCount} tool(s)`
                : `  ✗ ${s.name} — failed: ${s.error ?? "unknown"}`,
            );
            push({ kind: "system", text: `MCP servers:\n${lines.join("\n")}` });
          }
          break;
        }
        case "plugins": {
          const ps = session.plugins;
          if (ps.length === 0) {
            push({
              kind: "system",
              text: "no plugins loaded — drop them in ~/.arterm/plugins/<name>/ and set trust in config",
            });
          } else {
            const lines = ps.map((p) =>
              p.status === "loaded"
                ? `  ${p.trust === "trusted" ? "✓" : "•"} ${p.name} [${p.trust}] — ${p.toolCount} tool(s)${
                    p.blocked ? `, ${p.blocked} blocked` : ""
                  }`
                : `  ✗ ${p.name} — failed: ${p.error ?? "unknown"}`,
            );
            push({ kind: "system", text: `Plugins:\n${lines.join("\n")}` });
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
    ],
  );

  const submit = useCallback(
    async (value: string) => {
      const text = value.trim();
      setInput("");
      if (!text) return;
      setScrollOffset(0); // sending pins the view back to the latest
      setHistory((h) => historyPush(h, text));
      if (text === "?") {
        push({ kind: "system", text: HELP });
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
      push({ kind: "user", text });
      const controller = new AbortController();
      abortRef.current = controller;
      await session.agent.run(text, controller.signal);
      abortRef.current = null;
    },
    [session, handleSlash, push],
  );

  // Up/Down recall previously submitted prompts (shell-style history).
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
  const mode = permMode.toUpperCase();

  // Clamp the scroll offset to the measured content and expose the max to the wheel
  // handler (which runs outside render via a ref).
  const maxOffset = Math.max(0, totalLines - viewportRows);
  maxOffsetRef.current = maxOffset;
  const clampedOffset = Math.min(scrollOffset, maxOffset);

  return (
    <Box flexDirection="column" width={columns}>
      <Transcript
        items={items}
        live={live}
        viewportRows={viewportRows}
        marginBottom={clampedOffset}
        columns={columns}
        onMeasure={handleMeasure}
      />
      {/* Bottom region: measured (bottomRef) so the viewport height above can be
          computed as terminal rows − this height. Holds the scroll affordance, the
          input/overlays, the goal line, and the status bar. */}
      <Box ref={bottomRef} flexDirection="column">
        {clampedOffset > 0 ? (
          <Text color="gray" dimColor>
            ↑ {clampedOffset} satır yukarıda · tekerleği aşağı çevir / mesaj gönder = en alta dön
          </Text>
        ) : null}
        {pending ? (
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
          />
        ) : (
          <Box marginTop={1}>
            {busy && autoState === "idle" ? (
              // A normal turn shows a static spinner (Esc cancels). During an autonomous
              // run the prompt stays live even while busy, so typed /pause /steer /stop
              // (and plain-text steering) reach the engine between/within steps.
              <Text color="yellow">● working… (Esc to cancel)</Text>
            ) : (
              <InputLine
                active={!busy || autoState !== "idle"}
                value={input}
                commands={COMMANDS}
                columns={columns}
                onChange={setInput}
                onSubmit={submit}
                onHelp={() => push({ kind: "system", text: HELP })}
                onHistoryPrev={onHistoryPrev}
                onHistoryNext={onHistoryNext}
              />
            )}
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
          ctxWindow={session.config.context?.window ?? DEFAULT_CTX}
          toolCount={session.toolCount}
          mode={mode}
          columns={columns}
        />
      </Box>
    </Box>
  );
}
