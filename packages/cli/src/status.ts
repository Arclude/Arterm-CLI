import { join } from "node:path";
import { ARTERM_HOME, type McpCheckResult, type PluginCheckResult, loadConfig } from "@arterm/core";
import { McpManager, PluginLoader } from "@arterm/tools";

/** Combined health report printed by `arterm status`. */
export interface StatusReport {
  mcp: McpCheckResult[];
  plugins: PluginCheckResult[];
}

/** True when any MCP server or plugin is unhealthy. */
export function hasFailures(report: StatusReport): boolean {
  return report.mcp.some((r) => !r.ok) || report.plugins.some((r) => !r.ok);
}

/** Render the report as a human-readable ✓/✗ block. */
export function formatStatusText(report: StatusReport): string {
  const lines: string[] = ["MCP servers:"];
  if (report.mcp.length === 0) lines.push("  (none configured)");
  for (const r of report.mcp) {
    lines.push(
      r.ok
        ? `  ✓ ${r.name} — ${r.latencyMs}ms · ${r.toolCount ?? 0} tool(s)`
        : `  ✗ ${r.name} — ${r.error ?? "unknown"}`,
    );
  }
  lines.push("Plugins:");
  if (report.plugins.length === 0) lines.push("  (none installed)");
  for (const r of report.plugins) {
    lines.push(
      r.ok
        ? `  ✓ ${r.name} — ${r.toolCount ?? 0} tool(s)`
        : `  ✗ ${r.name} — ${r.error ?? "unknown"}`,
    );
  }
  return lines.join("\n");
}

/**
 * Headless health check for `arterm status`: connect to every configured MCP
 * server, load every plugin, probe them, print the report, and set exit code 1
 * when anything is unhealthy.
 */
export async function runStatus(opts: { json?: boolean }): Promise<void> {
  const config = await loadConfig();
  const mcp = new McpManager(config.mcpServers);
  const pluginTrust = Object.fromEntries(
    Object.entries(config.plugins ?? {}).map(([name, p]) => [name, p.trust]),
  );
  const plugins = new PluginLoader(join(ARTERM_HOME, "plugins"), pluginTrust);

  // There are no pre-existing connections in headless: connecting IS the check;
  // the probe pass afterwards adds per-server latency.
  await Promise.all([mcp.connect(), plugins.load()]);
  const report: StatusReport = { mcp: await mcp.check(), plugins: await plugins.check() };

  process.stdout.write(
    opts.json ? `${JSON.stringify(report, null, 2)}\n` : `${formatStatusText(report)}\n`,
  );

  await mcp.close();
  // exitCode (not process.exit) so stdout flushes before the process ends.
  if (hasFailures(report)) process.exitCode = 1;
}
