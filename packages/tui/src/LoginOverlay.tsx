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
  hostValue,
  oauthUrl,
}: {
  step: "provider" | "host" | "key" | "oauth";
  providers: LoginProvider[];
  index: number;
  /** Active provider id, marked in the list. */
  current: string;
  /** Provider ids with a stored key, marked ✓ (you can switch to them without re-entering). */
  signedIn: string[];
  /** The provider chosen on the first step (set once step === "key"). */
  selected?: LoginProvider;
  /** The key typed so far (rendered masked); on the oauth step, the pasted code. */
  keyValue?: string;
  /** The base URL typed so far (host step, shown in the clear — it's not a secret). */
  hostValue?: string;
  /** The authorize URL for the oauth step ("" while it is being built). */
  oauthUrl?: string;
}): React.ReactElement {
  if (step === "host" && selected) {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Box>
          <Text color="cyan" bold>
            ── Sign in to {selected.label} ──
          </Text>
        </Box>
        <Text color="gray" dimColor>
          {"  paste the base URL (OpenAI-compatible /v1 endpoint) · Enter next · Esc cancel"}
        </Text>
        <Box>
          <Text color="cyan">{"🌐 "}</Text>
          <Text>{hostValue ?? ""}</Text>
          <Text color="cyan">▏</Text>
        </Box>
        <Text color="gray" dimColor>
          {"  e.g. https://agentrouter.org/v1  ·  http://localhost:1234/v1"}
        </Text>
      </Box>
    );
  }
  if (step === "oauth" && selected) {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Box>
          <Text color="cyan" bold>
            ── Sign in to {selected.label} (subscription) ──
          </Text>
        </Box>
        <Text color="gray" dimColor>
          {oauthUrl
            ? "  browser opened — approve, then paste the code from the callback page"
            : "  building sign-in link…"}
        </Text>
        {oauthUrl ? (
          <Box paddingLeft={2}>
            <Text color="blue" wrap="wrap">
              {oauthUrl}
            </Text>
          </Box>
        ) : null}
        <Box>
          <Text color="cyan">{"🔗 "}</Text>
          <Text>{keyValue ?? ""}</Text>
          <Text color="cyan">▏</Text>
        </Box>
        <Text color="gray" dimColor>
          {"  paste `code#state` · Enter sign in · Esc cancel"}
        </Text>
      </Box>
    );
  }

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
          {selected.needsHost
            ? "  paste your API key (leave blank if the host needs none) · Enter save · Esc cancel"
            : "  paste your API key · Enter save · Esc cancel"}
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
            {"  or use your subscription instead: Esc, then press o on this provider"}
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
          {"   ↑/↓ move · Enter select · o subscription · r re-key · x remove · Esc close"}
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
              {isIn
                ? " · signed in"
                : p.needsHost
                  ? " · host + key"
                  : p.needsKey
                    ? " · needs key"
                    : " · local"}
              {p.supportsOAuth ? " · o = subscription" : ""}
              {p.id === current ? "  ← current" : ""}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}
