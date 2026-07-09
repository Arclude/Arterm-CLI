import type { DiffRow } from "@arterm/core";
import { Box, Text } from "ink";
import type React from "react";
import { Markdown } from "./markdown.js";
import type { DisplayItem } from "./types.js";

interface Props {
  items: DisplayItem[];
  live: string;
}

function MessageBlock({
  label,
  color,
  children,
}: {
  label: string;
  color: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={color}
      borderTop={false}
      borderRight={false}
      borderBottom={false}
      paddingLeft={1}
    >
      <Text color={color} bold>
        {label}
      </Text>
      {children}
    </Box>
  );
}

function fmtTok(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function truncate(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** Colour a diff-preview line by its leading marker. */
function diffLineColor(line: string): string {
  const c = line[0];
  if (c === "+") return "green";
  if (c === "-") return "red";
  if (c === "@" || c === "…") return "cyan";
  return "gray";
}

/**
 * Rich, git-style diff rendered from a completed edit/write/multi_edit: a line-number
 * gutter (old · new) beside each line, removals red, additions green, context in the
 * default colour, and collapsed regions marked by a cyan hunk header.
 */
function DiffView({
  path,
  rows,
  isError,
  outcome,
}: {
  path?: string;
  rows: DiffRow[];
  isError?: boolean;
  outcome?: string;
}): React.ReactElement {
  const width = rows.reduce((m, r) => Math.max(m, r.old ?? 0, r.new ?? 0), 0).toString().length;
  const pad = (n?: number): string =>
    n === undefined ? " ".repeat(width) : String(n).padStart(width);
  return (
    <Box flexDirection="column">
      <Text color={isError ? "red" : "yellow"} bold>
        {"✎ "}
        {path ?? "edit"}
      </Text>
      <Box flexDirection="column" paddingLeft={1}>
        {rows.map((r, i) => {
          if (r.kind === "hunk") {
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: static diff rows, never reordered
              <Text key={i} color="cyan" dimColor>
                {r.text}
              </Text>
            );
          }
          const marker = r.kind === "add" ? "+" : r.kind === "del" ? "-" : " ";
          const color = r.kind === "add" ? "green" : r.kind === "del" ? "red" : undefined;
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: static diff rows, never reordered
            <Text key={i} wrap="truncate-end">
              <Text color="gray" dimColor>
                {pad(r.old)} {pad(r.new)} │{" "}
              </Text>
              <Text color={color}>
                {marker} {r.text.length > 0 ? r.text : " "}
              </Text>
            </Text>
          );
        })}
      </Box>
      {isError && outcome ? (
        <Box paddingLeft={1}>
          <Text color="red">└─ {truncate(outcome, 200)}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

/** Grouped command reference, rendered by the `help` item. */
const HELP_GROUPS: { title: string; items: [string, string][] }[] = [
  {
    title: "Chat & models",
    items: [
      ["/help", "show this help  (or press ?)"],
      ["/model [name|N]", "model picker, or switch directly (Alt+P)"],
      ["/models", "open the model picker (type to filter)"],
      ["/login", "sign in to a provider (provider + API key)"],
      ["/catalog [query]", "search the models.dev catalog (~5k)"],
      ["/clear", "reset the conversation"],
      ["/exit", "quit  (or Ctrl+C)"],
    ],
  },
  {
    title: "Autonomy",
    items: [
      ["/goal <text>", "run autonomously toward a goal"],
      ["/autonomy <mode> <goal>", "once | eternal | parallel | phased"],
      ["/sdd <brief>", "spec → task graph → parallel execution"],
      ["/steer <text>", "redirect the goal · /pause /resume /stop"],
    ],
  },
  {
    title: "Context",
    items: [
      ["/compact", "shrink context (auto when near full)"],
      ["/cost", "token usage + estimated cost"],
      ["/config", "show the resolved configuration"],
    ],
  },
  {
    title: "Extensions",
    items: [
      ["/mcp [check|reload]", "MCP servers — status · probe · reconnect"],
      ["/plugins [check|reload]", "plugins — status · validate · rescan"],
      ["/skills · /skill <n>", "list skills · run one by name"],
      ["/web [port]", "open the live monitoring dashboard (web)"],
    ],
  },
  {
    title: "Permissions",
    items: [
      ["/mode [ask|auto|plan|yolo]", "set mode (no arg cycles)"],
      ["/auto /plan /ask /yolo", "shortcuts for /mode"],
    ],
  },
];

const HELP_FOOTER: [string, string][] = [
  [
    "Keys",
    "Enter send · ↑/↓ history · Shift+Tab cycle mode · Alt+P models · Esc cancel · Ctrl+C quit",
  ],
  ["Modes", "ASK prompts · AUTO auto-approves edits · PLAN read-only · YOLO approves all"],
  ["Edit", "Backspace del char · Ctrl+W del word · Ctrl+U clear line"],
];

const CMD_COL = 27;

/** Styled welcome banner (once, at startup). */
function BannerBlock({ provider, model }: { provider: string; model: string }): React.ReactElement {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Box>
        <Text color="cyan" bold>
          Arterm
        </Text>
        <Text color="gray"> · terminal AI coding agent</Text>
      </Box>
      <Text color="gray">
        provider <Text color="white">{provider}</Text> · model <Text color="white">{model}</Text>
      </Text>
      <Text color="gray">
        Type <Text color="cyan">/help</Text> or <Text color="cyan">?</Text> for commands ·{" "}
        <Text color="cyan">Shift+Tab</Text> cycles permission mode
      </Text>
    </Box>
  );
}

/** Styled, grouped command reference (on /help or `?`). */
function HelpPanel(): React.ReactElement {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text color="cyan" bold>
        Commands
      </Text>
      {HELP_GROUPS.map((group) => (
        <Box key={group.title} flexDirection="column" marginTop={1}>
          <Text color="magenta" bold>
            {group.title}
          </Text>
          {group.items.map(([cmd, desc]) => (
            <Box key={cmd}>
              <Text color="cyan">{cmd.padEnd(CMD_COL)}</Text>
              <Text color="gray">{desc}</Text>
            </Box>
          ))}
        </Box>
      ))}
      <Box flexDirection="column" marginTop={1}>
        {HELP_FOOTER.map(([label, text]) => (
          <Box key={label}>
            <Text color="yellow">{label.padEnd(7)}</Text>
            <Text color="gray" dimColor>
              {text}
            </Text>
          </Box>
        ))}
      </Box>
    </Box>
  );
}

export function Item({ item }: { item: DisplayItem }): React.ReactElement {
  switch (item.kind) {
    case "user":
      return (
        <MessageBlock label="USER" color="cyan">
          <Text>{item.text}</Text>
        </MessageBlock>
      );
    case "assistant":
      return (
        <MessageBlock label="ASSISTANT" color="green">
          <Markdown text={item.text} />
        </MessageBlock>
      );
    case "tool": {
      // A completed mutating tool (edit/write/multi_edit) renders its rich diff.
      if (item.diffRows && item.diffRows.length > 0) {
        return (
          <DiffView
            path={item.path}
            rows={item.diffRows}
            isError={item.isError}
            outcome={item.output}
          />
        );
      }
      // A result row (output, no args) renders only the indented tree line so it
      // reads as the continuation of its call row rather than a second "• name".
      if (item.output !== undefined && item.args === undefined) {
        return (
          <Box paddingLeft={2}>
            <Text color={item.isError ? "red" : "gray"}>└─ {truncate(item.output, 400)}</Text>
          </Box>
        );
      }
      // A file-mutating call (edit/write/multi_edit) renders its diff so the
      // change is visible even in auto/yolo mode where no permission prompt shows.
      if (item.diff) {
        const [head = item.name, ...body] = item.diff.split("\n");
        return (
          <Box flexDirection="column">
            <Text color={item.isError ? "red" : "yellow"} bold>
              {"• "}
              {head}
            </Text>
            <Box flexDirection="column" paddingLeft={2}>
              {body.map((line, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: static diff lines, never reordered
                <Text key={i} color={diffLineColor(line)} wrap="truncate">
                  {line.length > 0 ? line : " "}
                </Text>
              ))}
            </Box>
          </Box>
        );
      }
      return (
        <Box>
          <Text color={item.isError ? "red" : "yellow"} bold>
            {"• "}
            {item.name}
          </Text>
          {item.args ? <Text color="gray"> {truncate(item.args, 60)}</Text> : null}
        </Box>
      );
    }
    case "system":
      return (
        <Box paddingLeft={1}>
          <Text color="gray">{item.text}</Text>
        </Box>
      );
    case "banner":
      return <BannerBlock provider={item.provider} model={item.model} />;
    case "help":
      return <HelpPanel />;
    case "stats":
      return (
        <Box>
          <Text color="gray" dimColor>
            [↑{fmtTok(item.inTok)} ↓{fmtTok(item.outTok)} · {item.rounds} round
            {item.rounds === 1 ? "" : "s"} · {(item.ms / 1000).toFixed(1)}s]
          </Text>
        </Box>
      );
  }
}

export function MessageList({ items, live }: Props): React.ReactElement {
  return (
    <Box flexDirection="column">
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
  );
}
