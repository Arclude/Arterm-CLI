import type { Tool } from "@arterm/core";
import { Box, Text, useInput } from "ink";
import type React from "react";

export interface PendingPermission {
  tool: Tool;
  args: Record<string, unknown>;
  resolve: (answer: "allow" | "allow_always" | "deny") => void;
}

export function PermissionPrompt({ pending }: { pending: PendingPermission }): React.ReactElement {
  useInput((input, key) => {
    const ch = input.toLowerCase();
    if (ch === "y") pending.resolve("allow");
    else if (ch === "a") pending.resolve("allow_always");
    else if (ch === "n" || key.escape) pending.resolve("deny");
  });

  const summary = pending.tool.preview?.(pending.args) ?? pending.tool.name;
  // Border-free on purpose: a bordered box that appears/disappears leaves "ghost"
  // outlines in terminals that don't fully erase the previous dynamic frame.
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color="yellow" bold>
        ⚠ Permission required — {summary}
      </Text>
      <Text color="gray">
        [y] allow once · [a] always allow {pending.tool.name} · [n] deny
      </Text>
    </Box>
  );
}
