import { Box, Text } from "ink";
import type React from "react";
import type { DisplayItem } from "./types.js";

interface Props {
  items: DisplayItem[];
  live: string;
}

function Item({ item }: { item: DisplayItem }): React.ReactElement {
  switch (item.kind) {
    case "user":
      return (
        <Box>
          <Text color="blue" bold>
            {"› "}
          </Text>
          <Text>{item.text}</Text>
        </Box>
      );
    case "assistant":
      return <Text>{item.text}</Text>;
    case "tool":
      return (
        <Box flexDirection="column" marginLeft={2}>
          <Text color={item.isError ? "red" : "magenta"}>⚙ {item.name}</Text>
          <Text color="gray">{truncate(item.text)}</Text>
        </Box>
      );
    case "system":
      return <Text color="gray">{item.text}</Text>;
  }
}

function truncate(text: string, max = 600): string {
  return text.length > max ? `${text.slice(0, max)}\n… (${text.length} chars)` : text;
}

export function MessageList({ items, live }: Props): React.ReactElement {
  return (
    <Box flexDirection="column" gap={1}>
      {items.map((item, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: transcript is append-only
        <Item key={i} item={item} />
      ))}
      {live ? <Text>{live}</Text> : null}
    </Box>
  );
}
