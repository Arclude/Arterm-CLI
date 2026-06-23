import {
  PERMISSION_MODES,
  fetchCatalog,
  type ModelInfo,
  type PermissionAsker,
  type PermissionMode,
  searchCatalog,
} from "@arterm/core";
import { Box, Static, Text, useApp, useInput } from "ink";
import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type HistoryNav,
  emptyHistory,
  historyDown,
  historyPush,
  historyUp,
  reduceInput,
} from "./editing.js";
import { Item } from "./MessageList.js";
import { ModelPicker } from "./ModelPicker.js";
import { type PendingPermission, PermissionPrompt } from "./PermissionPrompt.js";
import { type Status, StatusBar } from "./StatusBar.js";
import type { DisplayItem, Session } from "./types.js";

/** Soft context-window estimate for the status-bar gauge (local models rarely report one). */
const DEFAULT_CTX = 32768;

const HELP = [
  "Commands (type and press Enter):",
  "  /help                 show this help        (or press ? )",
  "  /model                open the model picker (or press Alt+P)",
  "  /model <name|N>       switch model directly",
  "  /models               open the model picker (type to filter)",
  "  /catalog [query]      search the models.dev catalog (~5k models)",
  "  /clear                reset the conversation",
  "  /goal <text>          run autonomously toward a goal (decide→act→reflect→repeat)",
  "  /steer <text>         redirect the running goal · /pause /resume /stop",
  "  /compact              shrink the conversation context (auto when near full)",
  "  /mcp                  list connected MCP servers and their tools",
  "  /plugins              list loaded plugins (with trust + gating)",
  "  /skills · /skill <n>  list skills · run a skill by name",
  "  /mode [ask|auto|plan|yolo]  set permission mode (no arg cycles)",
  "  /auto /plan /ask /yolo      shortcuts for /mode",
  "  /exit                 quit (or Ctrl+C)",
  "Keys:  Enter send · ↑/↓ history · Shift+Tab cycle mode · Alt+P models · Esc cancel · Ctrl+C quit",
  "Modes: ASK prompts · AUTO auto-approves edits · PLAN read-only · YOLO approves all",
  "Edit:  Backspace del char · Ctrl+W del word · Ctrl+U clear line",
].join("\n");

/** Custom single-line input so `?` on an empty line opens help. */
function InputLine({
  active,
  value,
  onChange,
  onSubmit,
  onHelp,
  onHistoryPrev,
  onHistoryNext,
}: {
  active: boolean;
  value: string;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
  onHelp: () => void;
  onHistoryPrev: () => void;
  onHistoryNext: () => void;
}): React.ReactElement {
  useInput(
    (input, key) => {
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
  return (
    <Box>
      <Text color="cyan" bold>
        {"› "}
      </Text>
      <Text>{value}</Text>
      <Text color="cyan">▏</Text>
      {value === "" ? <Text color="gray"> message…  (type ? for help)</Text> : null}
    </Box>
  );
}

/** Modes cycled by Shift+Tab; yolo is deliberately excluded (set it via /mode yolo). */
const MODE_CYCLE: PermissionMode[] = ["ask", "auto", "plan"];

export function App({
  session,
  initialGoal,
}: {
  session: Session;
  initialGoal?: string;
}): React.ReactElement {
  const { exit } = useApp();
  const [items, setItems] = useState<DisplayItem[]>([]);
  const [status, setStatus] = useState<Status>("idle");
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
  const filteredPickerModels = useMemo(() => {
    const q = pickerQuery.trim().toLowerCase();
    return q ? pickerModels.filter((m) => m.name.toLowerCase().includes(q)) : pickerModels;
  }, [pickerModels, pickerQuery]);

  const abortRef = useRef<AbortController | null>(null);
  const turnStartRef = useRef(0);
  const turnRef = useRef({ inTok: 0, outTok: 0, rounds: 0 });

  const push = useCallback((item: DisplayItem) => setItems((prev) => [...prev, item]), []);

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
          turnStartRef.current = Date.now();
          turnRef.current = { inTok: 0, outTok: 0, rounds: 0 };
          break;
        case "assistant_message": {
          const text = event.message.content.trim();
          if (text) push({ kind: "assistant", text });
          turnRef.current.rounds += 1;
          break;
        }
        case "tool_call":
          setStatus("tool");
          push({
            kind: "tool",
            name: event.call.name,
            args: JSON.stringify(event.call.arguments),
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
          push({ kind: "system", text: `✗ denied ${event.name}` });
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
        case "error":
          push({ kind: "system", text: `error: ${event.error}` });
          break;
        case "turn_end":
          setStatus("idle");
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
      const models = await session.listModels();
      setPickerModels(models);
      const cur = models.findIndex((m) => m.name === session.agent.model);
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

  // Permission mode: cycle with Shift+Tab, set explicitly via /mode (and /auto, /plan…).
  const applyMode = useCallback(
    (next: PermissionMode): void => {
      session.setMode(next);
      setPermMode(next);
      push({ kind: "system", text: `▸ permission mode → ${next.toUpperCase()}` });
    },
    [session, push],
  );

  // Alt+P (or Ctrl+P) opens the model picker.
  useInput(
    (input2, key) => {
      if ((key.meta || key.ctrl) && (input2 === "p" || input2 === "P")) void openPicker();
    },
    { isActive: status === "idle" && !pickerOpen && !pending },
  );

  // Shift+Tab cycles the permission mode (ASK → AUTO → PLAN).
  useInput(
    (_input, key) => {
      if (key.tab && key.shift) {
        const i = MODE_CYCLE.indexOf(permMode);
        applyMode(MODE_CYCLE[(i + 1) % MODE_CYCLE.length] ?? "ask");
      }
    },
    { isActive: status === "idle" && !pickerOpen && !pending },
  );

  // Picker navigation + type-to-search filtering.
  useInput(
    (input2, key) => {
      const list = filteredPickerModels;
      if (key.upArrow) setPickerIndex((i) => Math.max(0, i - 1));
      else if (key.downArrow) setPickerIndex((i) => Math.min(list.length - 1, i + 1));
      else if (key.return) {
        const m = list[pickerIndex];
        if (m) choose(m.name);
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
        case "steer": {
          const note = rest.join(" ").trim();
          if (!note) push({ kind: "system", text: "usage: /steer <note>" });
          else session.autonomy.steer(note);
          break;
        }
        case "pause":
          session.autonomy.pause();
          break;
        case "resume":
          session.autonomy.resume();
          break;
        case "stop":
          session.autonomy.stop();
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
            push({ kind: "system", text: "no skills found — add markdown files to ~/.arterm/skills/" });
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
          choose(picked ? picked.name : arg);
          break;
        }
        default:
          push({ kind: "system", text: `unknown command: /${cmd} — type ? for help` });
      }
    },
    [session, exit, openPicker, choose, push, pickerModels, applyMode, permMode],
  );

  const submit = useCallback(
    async (value: string) => {
      const text = value.trim();
      setInput("");
      if (!text) return;
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

  return (
    <Box flexDirection="column">
      <Static items={items}>
        {(item, i) => <Item key={i} item={item} />}
      </Static>
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
      ) : (
        <Box marginTop={1}>
          {busy ? (
            <Text color="yellow">● working… (Esc to cancel)</Text>
          ) : (
            <InputLine
              active={!busy}
              value={input}
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
        provider={session.providerLabel}
        model={model}
        status={status}
        inTok={inTok}
        outTok={outTok}
        ctxUsed={ctxUsed}
        ctxWindow={DEFAULT_CTX}
        toolCount={session.toolCount}
        mode={mode}
      />
    </Box>
  );
}
