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

  const preview = pending.tool.preview?.(pending.args) ?? pending.tool.name;
  // First line is the one-line summary; the rest (if any) is a diff body whose
  // lines are coloured by their leading marker.
  const [head = pending.tool.name, ...body] = preview.split("\n");
  // Border-free on purpose: a bordered box that appears/disappears leaves "ghost"
  // outlines in terminals that don't fully erase the previous dynamic frame.
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color="yellow" bold>
        ⚠ Permission required — {head}
      </Text>
      {body.length > 0 ? (
        <Box flexDirection="column" marginLeft={2}>
          {body.map((line, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static diff lines, never reordered
            <Text key={i} color={diffLineColor(line)} wrap="truncate">
              {line.length > 0 ? line : " "}
            </Text>
          ))}
        </Box>
      ) : null}
      <Text color="gray">[y] allow once · [a] always allow {pending.tool.name} · [n] deny</Text>
    </Box>
  );
}

/** Colour a diff-preview line by its leading marker. */
function diffLineColor(line: string): string {
  const c = line[0];
  if (c === "+") return "green";
  if (c === "-") return "red";
  if (c === "@" || c === "…") return "cyan";
  return "gray";
}
