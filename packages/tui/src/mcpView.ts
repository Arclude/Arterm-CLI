/**
 * `/mcp` — both directions of it.
 *
 * MCP is one word for two opposite relationships, and this surface only ever
 * showed one of them. `config.mcpServers` is the list Arterm CONNECTS to as a
 * client; it is empty on a fresh install, so `/mcp` answered "no MCP servers
 * configured" — while the same binary was shipping two servers of its own.
 *
 * `arterm mcp` (this project's memory) and `arterm mcp serve` (Arterm's own
 * tools) are servers Arterm IS, for another client to consume. Arterm never
 * connects to them, and it must not: reaching its own memory through a second
 * process would spawn a child to fetch what `memory_search` already answers
 * in-process. They belong on this screen as something OFFERED, not as something
 * connected.
 *
 * The actionable half is the config snippet. "We publish a memory server" is
 * trivia; the line another client needs in ITS config is the answer.
 */

import type { McpServerSummary } from "@arterm/core";

export interface PublishedServer {
  /** The command another client runs to reach it. */
  command: string;
  what: string;
  /** Live detail — which memory engine is behind it, what `serve` would expose. */
  detail?: string;
}

/** What this binary offers, given what the session actually has configured. */
export function publishedServers(opts: {
  memoryEngine?: "cmem" | "jsonl" | "off";
  toolCount?: number;
}): PublishedServer[] {
  const engine = opts.memoryEngine ?? "jsonl";
  const servers: PublishedServer[] = [];
  if (engine !== "off") {
    servers.push({
      command: "arterm mcp",
      what: "this project's memory — search and remember",
      detail: `engine: ${engine}`,
    });
  }
  servers.push({
    command: "arterm mcp serve",
    what: "Arterm's own tools",
    detail:
      opts.toolCount !== undefined
        ? `${opts.toolCount} read-only tool(s); --writable adds the ones that prompt, never the destructive ones`
        : "read-only; --writable adds the ones that prompt, never the destructive ones",
  });
  return servers;
}

/** One row per server this session connects to. */
export function connectedLines(servers: readonly McpServerSummary[]): string[] {
  return servers.map((s) =>
    s.status === "connected"
      ? `  ✓ ${s.name} — ${s.toolCount} tool(s)`
      : `  ✗ ${s.name} — ${s.error ?? "failed"}`,
  );
}

/**
 * The whole screen.
 *
 * `connected` first because it is the one a user can change from here, and it
 * is what `/mcp check` and `/mcp reload` act on. Published second, with the
 * snippet, because that half is about a DIFFERENT program's config.
 */
export function formatMcpView(opts: {
  connected: readonly McpServerSummary[];
  published: readonly PublishedServer[];
}): string {
  const out: string[] = ["MCP has two directions, and this shows both.", ""];

  out.push("servers this session CONNECTS to (client — their tools join your roster):");
  if (opts.connected.length === 0) {
    out.push("  (none configured — add them to ~/.arterm/config.json → mcpServers)");
  } else {
    out.push(...connectedLines(opts.connected));
  }

  out.push("", "servers this Arterm PUBLISHES (for another client — Claude Code, an editor):");
  for (const s of opts.published) {
    out.push(`  ${s.command}${s.detail ? `  — ${s.detail}` : ""}`);
    out.push(`      ${s.what}`);
  }

  const first = opts.published[0];
  if (first) {
    out.push(
      "",
      "  Point another client at one from ITS config, not this one:",
      `    "mcpServers": { "arterm": { "command": "arterm", "args": ${JSON.stringify(
        first.command.split(" ").slice(1),
      )} } }`,
      "  Arterm does not connect to its own servers — `memory_search` already",
      "  answers in-process, and a second one would be a child process for nothing.",
    );
  }
  return out.join("\n");
}
