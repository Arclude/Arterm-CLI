import { Box, Text } from "ink";
import type React from "react";
import type { LoginProvider } from "./types.js";

/**
 * Two-step login overlay: first pick a provider, then (if it needs one) type an
 * API key. Opened with /login. Mirrors the ModelPicker interaction model.
 */
export function LoginOverlay({
  step,
  providers,
  index,
  current,
  signedIn,
  selected,
  keyValue,
}: {
  step: "provider" | "key";
  providers: LoginProvider[];
  index: number;
  /** Active provider id, marked in the list. */
  current: string;
  /** Provider ids with a stored key, marked ✓ (you can switch to them without re-entering). */
  signedIn: string[];
  /** The provider chosen on the first step (set once step === "key"). */
  selected?: LoginProvider;
  /** The key typed so far (rendered masked). */
  keyValue?: string;
}): React.ReactElement {
  if (step === "key" && selected) {
    const masked = "•".repeat((keyValue ?? "").length);
    return (
      <Box flexDirection="column" marginTop={1}>
        <Box>
          <Text color="cyan" bold>
            ── Sign in to {selected.label} ──
          </Text>
        </Box>
        <Text color="gray" dimColor>
          {"  paste your API key · Enter save · Esc cancel"}
        </Text>
        <Box>
          <Text color="cyan">{"🔑 "}</Text>
          <Text>{masked}</Text>
          <Text color="cyan">▏</Text>
        </Box>
        <Text color="gray" dimColor>
          {`  stored encrypted as "${selected.id}" in ~/.arterm/secrets.json`}
        </Text>
        {selected.supportsOAuth ? (
          <Text color="gray" dimColor>
            {`  or sign in with your subscription: run \`arterm login ${selected.id}\` in a terminal`}
          </Text>
        ) : null}
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Text color="cyan" bold>
          ── Choose a provider ──
        </Text>
        <Text color="gray" dimColor>
          {"   ↑/↓ move · Enter select · r re-key · x remove · Esc close"}
        </Text>
      </Box>
      {providers.map((p, i) => {
        const sel = i === index;
        const isIn = signedIn.includes(p.id);
        return (
          <Box key={p.id}>
            <Text
              color={sel ? "black" : "white"}
              backgroundColor={sel ? "cyan" : undefined}
              bold={sel}
            >
              {sel ? " ❯ " : "   "}
              {isIn ? "✓ " : "  "}
              {p.id.padEnd(12)}
            </Text>
            <Text color="gray">
              {"  "}
              {p.label}
              {isIn ? " · signed in" : p.needsKey ? " · needs key" : " · local"}
              {p.id === current ? "  ← current" : ""}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}
