import type { ModelInfo, PermissionAsker } from "@arterm/core";
import { Box, Static, Text, useApp, useInput } from "ink";
import Spinner from "ink-spinner";
import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Item, MessageList } from "./MessageList.js";
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
  "  /models               open the model picker",
  "  /clear                reset the conversation",
  "  /exit                 quit (or Ctrl+C)",
  "Keys:  Enter send · ? help · Alt+P models · Esc cancel turn · Ctrl+C quit",
].join("\n");

/** Custom single-line input so `?` on an empty line opens help. */
function InputLine({
  active,
  value,
  onChange,
  onSubmit,
  onHelp,
}: {
  active: boolean;
  value: string;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
  onHelp: () => void;
}): React.ReactElement {
  useInput(
    (input, key) => {
      if (key.return) return onSubmit(value);
      if (key.backspace || key.delete) return onChange(value.slice(0, -1));
      if (key.escape || key.tab || key.upArrow || key.downArrow) return;
      if (key.ctrl || key.meta) return;
      if (input === "?" && value === "") return onHelp();
      if (input) onChange(value + input);
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

export function App({ session }: { session: Session }): React.ReactElement {
  const { exit } = useApp();
  const [items, setItems] = useState<DisplayItem[]>([]);
  const [live, setLive] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [input, setInput] = useState("");
  const [model, setModel] = useState(session.agent.model);
  const [pending, setPending] = useState<PendingPermission | null>(null);
  const [inTok, setInTok] = useState(0);
  const [outTok, setOutTok] = useState(0);
  const [ctxUsed, setCtxUsed] = useState(0);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerModels, setPickerModels] = useState<ModelInfo[]>([]);
  const [pickerIndex, setPickerIndex] = useState(0);
  const [pickerLoading, setPickerLoading] = useState(false);

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
        case "text_delta":
          setLive((prev) => prev + event.delta);
          break;
        case "assistant_message": {
          const text = event.message.content.trim();
          setLive("");
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
        case "error":
          setLive("");
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

  // Esc cancels a running turn.
  useInput(
    (_input, key) => {
      if (key.escape && status !== "idle") abortRef.current?.abort();
    },
    { isActive: status !== "idle" && !pending },
  );

  const openPicker = useCallback(async () => {
    setPickerOpen(true);
    setPickerLoading(true);
    try {
      const models = await session.listModels();
      setPickerModels(models);
      const cur = models.findIndex((m) => m.name === session.agent.model);
      setPickerIndex(cur >= 0 ? cur : 0);
    } catch {
      setPickerModels([]);
    } finally {
      setPickerLoading(false);
    }
  }, [session]);

  const choose = useCallback(
    (name: string) => {
      session.switchModel(name);
      setModel(name);
      push({ kind: "system", text: `✓ model → ${name}` });
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

  // Picker navigation.
  useInput(
    (_input, key) => {
      if (key.upArrow) setPickerIndex((i) => Math.max(0, i - 1));
      else if (key.downArrow) setPickerIndex((i) => Math.min(pickerModels.length - 1, i + 1));
      else if (key.return) {
        const m = pickerModels[pickerIndex];
        if (m) choose(m.name);
        setPickerOpen(false);
      } else if (key.escape) {
        setPickerOpen(false);
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
          setLive("");
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
    [session, exit, openPicker, choose, push, pickerModels],
  );

  const submit = useCallback(
    async (value: string) => {
      const text = value.trim();
      setInput("");
      if (!text) return;
      if (text === "?") {
        push({ kind: "system", text: HELP });
        return;
      }
      if (text.startsWith("/")) {
        await handleSlash(text);
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

  const busy = status !== "idle";
  const mode = session.yolo ? "YOLO" : "ASK";

  return (
    <Box flexDirection="column">
      <Static items={items}>
        {(item, i) => <Item key={i} item={item} />}
      </Static>
      {live ? <MessageList items={[]} live={live} /> : null}
      {pending ? (
        <PermissionPrompt pending={pending} />
      ) : pickerOpen ? (
        <ModelPicker
          models={pickerModels}
          index={pickerIndex}
          current={model}
          loading={pickerLoading}
        />
      ) : (
        <Box marginTop={1}>
          {busy ? (
            <Text color="gray">
              <Spinner type="dots" /> running — Esc to cancel
            </Text>
          ) : (
            <InputLine
              active={!busy}
              value={input}
              onChange={setInput}
              onSubmit={submit}
              onHelp={() => push({ kind: "system", text: HELP })}
            />
          )}
        </Box>
      )}
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
