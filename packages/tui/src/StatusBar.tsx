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

function bar(pct: number, width = 10): string {
  const filled = Math.max(0, Math.min(width, Math.round((pct / 100) * width)));
  return "█".repeat(filled) + "░".repeat(width - filled);
}

const Sep = (): React.ReactElement => (
  <Text color="gray" dimColor>
    {"  │  "}
  </Text>
);

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
}: Props): React.ReactElement {
  // Computed inline (no per-second timer) so the UI does not repaint while idle.
  const clock = new Date().toLocaleTimeString();
  const branch = gitBranch();
  const cwd = basename(process.cwd());
  const pct = ctxWindow ? Math.min(100, Math.round((ctxUsed / ctxWindow) * 100)) : 0;
  const dot = <Text color={status === "idle" ? "green" : "yellow"}>●</Text>;

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Text color="cyan" bold>
          ▌ARTERM
        </Text>
        <Text color="gray"> v{VERSION}</Text>
        <Sep />
        {dot}
        <Text color={status === "idle" ? "green" : "yellow"}> {status}</Text>
        <Sep />
        <Text color="magenta">
          {provider}/{model}
        </Text>
        <Sep />
        <Text color="gray">ctx </Text>
        <Text color={pct > 80 ? "red" : "blueBright"}>{bar(pct)}</Text>
        <Text color="gray">
          {" "}
          {pct}%/{fmtTok(ctxWindow || 0)}
        </Text>
        <Sep />
        <Text color="gray">
          ↑{fmtTok(inTok)} ↓{fmtTok(outTok)}
        </Text>
      </Box>
      <Box>
        <Text color="yellow">📁 {cwd}</Text>
        <Sep />
        <Text color="green">⎇ {branch}</Text>
        <Sep />
        <Text color="gray">🔧 {toolCount} tools</Text>
        <Sep />
        <Text color="gray">⏱ {clock}</Text>
        <Sep />
        <Text color={modeColor(mode)}>{mode}</Text>
      </Box>
      <Box>
        <Text color="gray" dimColor>
          Enter send   ? help   Alt+P models   Esc cancel   ^C quit
        </Text>
      </Box>
    </Box>
  );
}
