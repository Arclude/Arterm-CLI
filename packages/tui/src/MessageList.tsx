import type { DiffRow } from "@arterm/core";
import { memo } from "react";
import type React from "react";
import { EntryBoundary } from "./EntryBoundary.js";
import { Box, Text } from "./ink.js";
import { Markdown } from "./markdown.js";
import { padEndDisplay, truncateDisplay } from "./terminalWidth.js";
import { theme } from "./theme.js";
import { toolColor, toolGlyph } from "./toolGlyph.js";
import type { DisplayItem } from "./types.js";
import { glyphs } from "./uiGlyphs.js";

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

/** A tool's duration, at the precision anyone acts on. */
function fmtMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${String(Math.round((ms % 60_000) / 1000)).padStart(2, "0")}s`;
}

/** Output size — the other half of "why did that take four seconds". */
export function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)}MB`;
  if (n >= 1024) return `${Math.round(n / 1024)}KB`;
  return `${n}B`;
}

function truncate(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  // Measured in terminal columns: tool arguments carry paths, and a path can
  // hold anything a filesystem allows — emoji included, at two columns each.
  return truncateDisplay(t, max);
}

/**
 * Expand hard tabs to 8-column stops.
 *
 * A tab advances the terminal's cursor without painting anything, so a row
 * containing one gets a colourless gap in the middle of its wash and its
 * padding lands in the wrong column. Expanding up front makes the row's width
 * something this code can compute.
 */
function expandTabs(text: string, stop = 8): string {
  if (!text.includes("\t")) return text;
  let out = "";
  for (const ch of text) {
    if (ch === "\t") out += " ".repeat(stop - (out.length % stop));
    else out += ch;
  }
  return out;
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
  columns = 80,
}: {
  path?: string;
  rows: DiffRow[];
  isError?: boolean;
  outcome?: string;
  /** Pane width — the wash has to be painted out to a known column. */
  columns?: number;
}): React.ReactElement {
  const width = rows.reduce((m, r) => Math.max(m, r.old ?? 0, r.new ?? 0), 0).toString().length;
  const pad = (n?: number): string =>
    n === undefined ? " ".repeat(width) : String(n).padStart(width);
  // The gutter is `old new │ ` plus the marker and its space.
  const gutter = width * 2 + 5;
  // One column short of the pane on purpose: writing a printable space into
  // the final column leaves some terminals in pending-wrap, and the reset then
  // shows up as a visual spill onto the next line.
  const body = Math.max(8, columns - gutter - 2);
  return (
    <Box flexDirection="column">
      <Text color={isError ? theme.error : theme.warn} bold>
        {glyphs.filesChanged} {path ?? "edit"}
      </Text>
      <Box flexDirection="column" paddingLeft={1}>
        {rows.map((r, i) => {
          if (r.kind === "hunk") {
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: static diff rows, never reordered
              <Text key={i} color={theme.accent} dimColor>
                {r.text}
              </Text>
            );
          }
          const marker = r.kind === "add" ? "+" : r.kind === "del" ? "-" : " ";
          const color =
            r.kind === "add" ? theme.success : r.kind === "del" ? theme.error : undefined;
          // The wash goes on the TEXT, not the Box: Ink paints a background
          // only behind actual characters, so the row is padded out with real
          // spaces to give the colour something to sit on. A hard tab would
          // advance the cursor without painting, leaving a colourless gap and
          // desyncing the padding, so tabs are expanded to 8-column stops first.
          const text = expandTabs(r.text);
          const wash =
            theme.supportsBackground && r.kind === "add"
              ? theme.diffAddBg
              : theme.supportsBackground && r.kind === "del"
                ? theme.diffDelBg
                : undefined;
          const painted = wash ? padEndDisplay(truncateDisplay(text, body), body) : text;
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: static diff rows, never reordered
            <Text key={i} wrap="truncate-end">
              <Text color={theme.textMuted} dimColor>
                {pad(r.old)} {pad(r.new)} │{" "}
              </Text>
              <Text color={color} {...(wash ? { backgroundColor: wash } : {})}>
                {marker} {painted.length > 0 ? painted : " "}
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
      ["/copy [all]", "copy the last reply (or the whole conversation) to the clipboard"],
      ["drag", "drag to select text, release to copy (fullscreen)"],
      ["/rewind [n]", "undo a turn's file changes (no arg lists checkpoints); /redo goes forward"],
      ["/limits", "provider rate limits: what remains, when it resets"],
      ["/mouse", "says who owns the wheel — the app never captures it"],
      ["/clear", "reset the conversation"],
      ["/exit", "quit  (or Ctrl+C)"],
    ],
  },
  {
    title: "Autonomy",
    items: [
      ["/goal <text>", "run autonomously toward a goal"],
      ["/autonomy <mode> <goal>", "once | eternal | parallel | phased | team"],
      ["/team <task>", "leader assembles an agent team (roster → parallel rounds)"],
      ["/agents", "list agent definitions (.arterm/agents/*.md)"],
      ["/sdd <brief>", "spec → task graph → parallel execution"],
      ["/steer <text>", "redirect the goal · /pause /resume /stop"],
    ],
  },
  {
    title: "Context",
    items: [
      ["/context", "what is filling the window: composition, agents, compactions"],
      ["/compact", "shrink context (auto when near full)"],
      ["/cost", "token usage + estimated cost"],
      ["/config", "show the resolved configuration"],
    ],
  },
  {
    title: "Extensions",
    items: [
      ["/mcp [check|reload]", "MCP — what this session connects to, and what it publishes"],
      ["/plugins [check|reload]", "plugins — status · validate · rescan"],
      ["/skills · /skill <n>", "list skills · run one by name"],
    ],
  },
  {
    title: "Processes",
    items: [
      ["/ps", "background processes this session started — what is still running"],
      ["/ps kill <id>", "stop one  ·  /ps kill all stops every one"],
    ],
  },
  {
    title: "Permissions",
    items: [
      ["/mode [ask|auto|plan|yolo]", "set mode (no arg cycles)"],
      ["/auto /plan /ask /yolo", "shortcuts for /mode"],
      ["Shift+Tab", "cycle ASK → AUTO → PLAN → AUTONOMOUS (armed: a prompt runs as a goal)"],
      ["/permissions [mode] [outcome]", "what every tool is allowed to do right now"],
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
  // Discoverability is the whole feature here: a key nobody knows about is a
  // key nobody presses, and dragging a file is the half people try first.
  [
    "Images",
    "Ctrl+V pastes one from the clipboard (⌫ over [Image #1] removes it) · or drag a file in",
  ],
  [
    "Board",
    "Tab (or Ctrl/Alt+↑↓) step sub-agent · Enter inspect (empty prompt) · ↑↓ step while open · Esc close",
  ],
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

// Memoized: a scroll re-renders the transcript with a new offset, but each
// item's props are unchanged, so React skips re-running its markdown/diff render
// — only the cutter layout shifts. This is what keeps scroll fluid on a long
// transcript (without it, every wheel tick re-parses every message's markdown).
export const Item = memo(function Item({ item }: { item: DisplayItem }): React.ReactElement {
  // Wrapped per entry: Ink renders one tree, so a render error in any single
  // entry unmounts the whole UI — the session still alive underneath, the agent
  // possibly mid-turn, and a stack trace where the terminal used to be.
  return (
    <EntryBoundary label={`a ${item.kind} entry`}>
      <ItemBody item={item} />
    </EntryBoundary>
  );
});

function ItemBody({ item }: { item: DisplayItem }): React.ReactElement {
  switch (item.kind) {
    case "user":
      return (
        <MessageBlock label="USER" color="cyan">
          <Text>{item.text}</Text>
          {item.images ? (
            // The same marker a tool result gets, for the same reason: what the
            // model was shown has to be visible, and a picture the terminal
            // cannot draw is otherwise indistinguishable from one never sent.
            <Text dimColor>
              {glyphs.image}
              {item.images.count > 1 ? `×${item.images.count}` : ""} {fmtBytes(item.images.bytes)}{" "}
              attached
            </Text>
          ) : null}
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
      //
      // The measurements ride here rather than on the call row: none of them
      // exist until the tool returns. They were being recorded on the item and
      // rendered nowhere, so a call that took four seconds and one that took
      // four milliseconds looked the same, which is the difference between a
      // slow tool and a slow model.
      if (item.output !== undefined && item.args === undefined) {
        const meta = [
          item.ms !== undefined ? fmtMs(item.ms) : "",
          item.bytes ? fmtBytes(item.bytes) : "",
          item.tok ? `${fmtTok(item.tok)}t` : "",
          // A screenshot is a line of text here and a fortune in the context —
          // sent again on every later turn. The terminal cannot draw it, but
          // leaving its cost invisible is how a session gets expensive with no
          // visible cause.
          item.images
            ? `${glyphs.image}${item.images.count > 1 ? `×${item.images.count}` : ""} ${fmtBytes(item.images.bytes)}`
            : "",
        ]
          .filter(Boolean)
          .join(" · ");
        return (
          <Box paddingLeft={2}>
            <Text wrap="truncate-end">
              <Text color={item.isError ? theme.error : theme.textMuted}>
                └─ {truncate(item.output, 400)}
              </Text>
              {meta ? (
                <Text color={theme.textMuted} dimColor>
                  {"  · "}
                  {meta}
                </Text>
              ) : null}
            </Text>
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
      // The call row. Its glyph and colour are the tool's own: every call drew
      // the same `•` in the same yellow, so the shape of a turn — five reads,
      // an edit, a bash — was unreadable until you read the names.
      return (
        <Box>
          <Text color={item.isError ? theme.error : toolColor(item.name)} bold>
            {toolGlyph(item.name)} {item.name}
          </Text>
          {item.args ? <Text color={theme.textSecondary}> {truncate(item.args, 60)}</Text> : null}
        </Box>
      );
    }
    case "system":
      return (
        <Box paddingLeft={1}>
          <Text color={item.color ?? "gray"}>{item.text}</Text>
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
