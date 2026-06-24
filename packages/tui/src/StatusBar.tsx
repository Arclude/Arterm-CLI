import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { Box, Text } from "ink";
import type React from "react";

export type Status = "idle" | "thinking" | "tool";

interface Props {
  provider: string;
  model: string;
  status: Status;
  inTok: number;
  outTok: number;
  ctxUsed: number;
  ctxWindow: number;
  toolCount: number;
  mode: string;
  /** Terminal width in columns; drives the responsive layout. */
  columns: number;
}

const VERSION = "0.1.0";

function gitBranch(): string {
  try {
    const head = readFileSync(join(process.cwd(), ".git", "HEAD"), "utf8").trim();
    const m = head.match(/ref: refs\/heads\/(.+)/);
    return m?.[1] ?? head.slice(0, 7);
  } catch {
    return "—";
  }
}

function fmtTok(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

function bar(pct: number, width: number): string {
  const w = Math.max(1, width);
  const filled = Math.max(0, Math.min(w, Math.round((pct / 100) * w)));
  return "█".repeat(filled) + "░".repeat(w - filled);
}

/** Truncate to a max display length, marking the cut with an ellipsis. */
function clip(s: string, max: number): string {
  if (max <= 0) return "";
  return s.length <= max ? s : `${s.slice(0, Math.max(1, max - 1))}…`;
}

/** Status-bar color for each permission mode. */
function modeColor(mode: string): string {
  switch (mode) {
    case "YOLO":
      return "red";
    case "PLAN":
      return "cyan";
    case "AUTO":
      return "green";
    default:
      return "yellow";
  }
}

export function StatusBar({
  provider,
  model,
  status,
  inTok,
  outTok,
  ctxUsed,
  ctxWindow,
  toolCount,
  mode,
  columns,
}: Props): React.ReactElement {
  // Computed inline (no per-second timer) so the UI does not repaint while idle.
  const clock = new Date().toLocaleTimeString();
  const branch = gitBranch();
  const cwd = basename(process.cwd());
  const pct = ctxWindow ? Math.min(100, Math.round((ctxUsed / ctxWindow) * 100)) : 0;
  const statusColor = status === "idle" ? "green" : "yellow";

  const dot = <Text color={statusColor}>●</Text>;
  // Block meter width is clamped to the pane so it can never overflow its line.
  const meterW = Math.max(4, Math.min(10, columns - 22));
  const meter = <Text color={pct > 80 ? "red" : "blueBright"}>{bar(pct, meterW)}</Text>;
  const sepW = (
    <Text color="gray" dimColor>
      {"  │  "}
    </Text>
  );
  const sepN = (
    <Text color="gray" dimColor>
      {" · "}
    </Text>
  );

  // Wide panes get the dense two-row bar. Narrow panes stack each group on its
  // own truncating line so every detail stays visible instead of being clipped.
  if (columns < 84) {
    const m = clip(`${provider}/${model}`, Math.max(8, columns - 1));
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text wrap="truncate">
          <Text color="cyan" bold>
            ▌ARTERM
          </Text>
          <Text color="gray"> v{VERSION}</Text>
          {sepN}
          {dot}
          <Text color={statusColor}> {status}</Text>
          {sepN}
          <Text color={modeColor(mode)} bold>
            {mode}
          </Text>
        </Text>
        <Text color="magenta" wrap="truncate">
          {m}
        </Text>
        <Text wrap="truncate">
          <Text color="gray">ctx </Text>
          {meter}
          <Text color="gray">
            {" "}
            {pct}%/{fmtTok(ctxWindow || 0)}
          </Text>
          {sepN}
          <Text color="gray">
            ↑{fmtTok(inTok)} ↓{fmtTok(outTok)}
          </Text>
        </Text>
        <Text wrap="truncate">
          <Text color="yellow">📁 {cwd}</Text>
          {sepN}
          <Text color="green">⇡ {branch}</Text>
          {sepN}
          <Text color="gray">🔧 {toolCount}</Text>
          {sepN}
          <Text color="gray">⏱ {clock}</Text>
        </Text>
        <Text color="gray" dimColor wrap="truncate">
          ? help · Alt+P models · PgUp/PgDn scroll · ^C quit
        </Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text wrap="truncate">
        <Text color="cyan" bold>
          ▌ARTERM
        </Text>
        <Text color="gray"> v{VERSION}</Text>
        {sepW}
        {dot}
        <Text color={statusColor}> {status}</Text>
        {sepW}
        <Text color="magenta">
          {provider}/{model}
        </Text>
        {sepW}
        <Text color="gray">ctx </Text>
        {meter}
        <Text color="gray">
          {" "}
          {pct}%/{fmtTok(ctxWindow || 0)}
        </Text>
        {sepW}
        <Text color="gray">
          ↑{fmtTok(inTok)} ↓{fmtTok(outTok)}
        </Text>
      </Text>
      <Text wrap="truncate">
        <Text color="yellow">📁 {cwd}</Text>
        {sepW}
        <Text color="green">⇡ {branch}</Text>
        {sepW}
        <Text color="gray">🔧 {toolCount} tools</Text>
        {sepW}
        <Text color="gray">⏱ {clock}</Text>
        {sepW}
        <Text color={modeColor(mode)}>{mode}</Text>
      </Text>
      <Text color="gray" dimColor wrap="truncate">
        Enter send · ? help · Alt+P models · PgUp/PgDn scroll · ^C quit
      </Text>
    </Box>
  );
}
