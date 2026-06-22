import { Box, Text } from "ink";
import type React from "react";
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
          <Text>{item.text}</Text>
        </MessageBlock>
      );
    case "tool": {
      // A result row (output, no args) renders only the indented tree line so it
      // reads as the continuation of its call row rather than a second "• name".
      if (item.output !== undefined && item.args === undefined) {
        return (
          <Box paddingLeft={2}>
            <Text color={item.isError ? "red" : "gray"}>└─ {truncate(item.output, 400)}</Text>
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
          <Text>{live}</Text>
        </Box>
      ) : null}
    </Box>
  );
}
