import type { ModelInfo } from "@arterm/core";
import { Box, Text } from "ink";
import type React from "react";

function fmtBytes(n?: number): string {
  if (!n) return "";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
}

/** Interactive model selector overlay (opened with Alt+P or /models). */
export function ModelPicker({
  models,
  index,
  current,
  loading,
  query,
}: {
  models: ModelInfo[];
  index: number;
  current: string;
  loading?: boolean;
  query?: string;
}): React.ReactElement {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Text color="cyan" bold>
          ── Select a model ──
        </Text>
        <Text color="gray" dimColor>
          {"   type to filter · ↑/↓ move · Enter choose · Esc close"}
        </Text>
      </Box>
      <Box>
        <Text color="cyan">{"🔎 "}</Text>
        <Text>{query ?? ""}</Text>
        <Text color="cyan">▏</Text>
      </Box>
      {loading ? (
        <Text color="gray"> loading…</Text>
      ) : models.length === 0 ? (
        <Text color="gray">
          {"  "}
          {query ? "(no matches)" : "(no models found on this provider)"}
        </Text>
      ) : (
        models.map((m, i) => {
          const sel = i === index;
          return (
            <Box key={`${m.provider}/${m.name}`}>
              <Text
                color={sel ? "black" : "white"}
                backgroundColor={sel ? "cyan" : undefined}
                bold={sel}
              >
                {sel ? " ❯ " : "   "}
                {m.name.padEnd(30)}
              </Text>
              <Text color="gray">
                {"  "}
                {m.provider}
                {m.sizeBytes ? ` · ${fmtBytes(m.sizeBytes)}` : ""}
                {m.supportsTools ? " · tools" : ""}
                {m.name === current ? "  ← current" : ""}
              </Text>
            </Box>
          );
        })
      )}
    </Box>
  );
}
