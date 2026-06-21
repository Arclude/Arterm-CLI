import type { PermissionAsker, Tool } from "@arterm/core";
import { Box, Text, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { MessageList } from "./MessageList.js";
import type { PendingPermission } from "./PermissionPrompt.js";
import { PermissionPrompt } from "./PermissionPrompt.js";
import { type Status, StatusBar } from "./StatusBar.js";
import type { DisplayItem, Session } from "./types.js";

const HELP = [
  "/help            show this help",
  "/clear           clear the conversation",
  "/model <name>    switch model",
  "/models          list available models",
  "/exit            quit (or Ctrl+C)",
  "Esc              cancel the running turn",
].join("\n");

export function App({ session }: { session: Session }): React.ReactElement {
  const { exit } = useApp();
  const [items, setItems] = useState<DisplayItem[]>([]);
  const [live, setLive] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [tokens, setTokens] = useState(0);
  const [input, setInput] = useState("");
  const [model, setModel] = useState(session.agent.model);
  const [pending, setPending] = useState<PendingPermission | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const push = useCallback((item: DisplayItem) => setItems((prev) => [...prev, item]), []);

  // Wire the permission prompt into the agent's permission flow (once).
  useEffect(() => {
    const asker: PermissionAsker = (tool: Tool, args) =>
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

  // Subscribe to agent events (once).
  useEffect(() => {
    return session.bus.on((event) => {
      switch (event.type) {
        case "turn_start":
          setStatus("thinking");
          break;
        case "text_delta":
          setLive((prev) => prev + event.delta);
          break;
        case "assistant_message": {
          const text = event.message.content.trim();
          setLive("");
          if (text) push({ kind: "assistant", text });
          break;
        }
        case "tool_call":
          setStatus("tool");
          break;
        case "tool_result":
          push({ kind: "tool", name: event.name, text: event.output, isError: event.isError });
          setStatus("thinking");
          break;
        case "tool_denied":
          push({ kind: "system", text: `✗ denied ${event.name}` });
          break;
        case "usage":
          if (event.usage.totalTokens) setTokens((t) => t + (event.usage.totalTokens ?? 0));
          break;
        case "error":
          push({ kind: "system", text: `Error: ${event.error}` });
          break;
        case "turn_end":
          setStatus("idle");
          break;
      }
    });
  }, [session, push]);

  // Global keys: Esc cancels a running turn.
  useInput(
    (_input, key) => {
      if (key.escape && status !== "idle") abortRef.current?.abort();
    },
    { isActive: !pending },
  );

  const handleSlash = useCallback(
    async (raw: string): Promise<boolean> => {
      const [cmd, ...rest] = raw.slice(1).trim().split(/\s+/);
      switch (cmd) {
        case "help":
          push({ kind: "system", text: HELP });
          return true;
        case "clear":
          session.agent.reset();
          setItems([]);
          setLive("");
          setTokens(0);
          return true;
        case "exit":
        case "quit":
          exit();
          return true;
        case "model": {
          const name = rest.join(" ");
          if (!name) {
            push({ kind: "system", text: `current model: ${model}` });
          } else {
            session.switchModel(name);
            setModel(name);
            push({ kind: "system", text: `switched model → ${name}` });
          }
          return true;
        }
        case "models": {
          try {
            const list = await session.listModels();
            const names = list.map((m) => `  ${m.name}`).join("\n") || "  (none)";
            push({ kind: "system", text: `models:\n${names}` });
          } catch (err) {
            push({ kind: "system", text: `could not list models: ${(err as Error).message}` });
          }
          return true;
        }
        default:
          push({ kind: "system", text: `unknown command: /${cmd}` });
          return true;
      }
    },
    [session, exit, push, model],
  );

  const submit = useCallback(
    async (value: string) => {
      const text = value.trim();
      setInput("");
      if (!text) return;
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

  return (
    <Box flexDirection="column" gap={1}>
      <MessageList items={items} live={live} />
      {pending ? (
        <PermissionPrompt pending={pending} />
      ) : (
        <Box>
          <Text color={busy ? "gray" : "blue"} bold>
            {"› "}
          </Text>
          {busy ? (
            <Text color="gray">(running — Esc to cancel)</Text>
          ) : (
            <TextInput value={input} onChange={setInput} onSubmit={submit} />
          )}
        </Box>
      )}
      <StatusBar provider={session.providerLabel} model={model} status={status} tokens={tokens} />
    </Box>
  );
}
