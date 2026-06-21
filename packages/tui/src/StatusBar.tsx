import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import type React from "react";

export type Status = "idle" | "thinking" | "tool";

interface Props {
  provider: string;
  model: string;
  status: Status;
  tokens: number;
}

export function StatusBar({ provider, model, status, tokens }: Props): React.ReactElement {
  return (
    <Box borderStyle="round" borderColor="gray" paddingX={1} justifyContent="space-between">
      <Box>
        <Text color="cyan">{provider}</Text>
        <Text color="gray"> · </Text>
        <Text color="green">{model}</Text>
      </Box>
      <Box>
        {status === "idle" ? (
          <Text color="gray">ready</Text>
        ) : (
          <Text color="yellow">
            <Spinner type="dots" /> {status === "tool" ? "running tool" : "thinking"}
          </Text>
        )}
        <Text color="gray"> · {tokens} tok</Text>
      </Box>
    </Box>
  );
}
