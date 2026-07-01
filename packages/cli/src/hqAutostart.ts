import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

/**
 * Shared helper for the on-demand web dashboard: make sure an HQ aggregator is
 * reachable and return its URL, spawning a detached background one if needed.
 * Used by both `arterm --hq` and the `/hq` / `/web` TUI commands.
 */

const urlFor = (port: number): string => `http://127.0.0.1:${port}`;

async function healthy(url: string): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 500);
    const res = await fetch(`${url}/api/agents`, { signal: ctrl.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

/** True if nothing is listening on `port` (127.0.0.1). */
function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createServer();
    s.once("error", () => resolve(false));
    s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
  });
}

/** Ask the OS for a free ephemeral port. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      s.close(() => resolve(port));
    });
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Ensure an aggregator is up and return its base URL. Prefers `preferred` (so agents
 * share one dashboard) — reuses it if an aggregator is already there, spawns one if
 * it's free, and falls back to an auto-picked free port if `preferred` is taken by
 * something else. The background aggregator outlives this session on purpose.
 */
export async function ensureAggregator(preferred: number): Promise<string> {
  if (await healthy(urlFor(preferred))) return urlFor(preferred);
  const port = (await isPortFree(preferred)) ? preferred : await freePort();

  const { spawn } = await import("node:child_process");
  const mainJs = fileURLToPath(import.meta.url); // the bundled dist/main.js
  spawn(process.execPath, [mainJs, "hq", "--port", String(port)], {
    detached: true,
    stdio: "ignore",
  }).unref();

  for (let i = 0; i < 40; i++) {
    await sleep(200);
    if (await healthy(urlFor(port))) return urlFor(port);
  }
  throw new Error(`aggregator did not start on ${urlFor(port)} — try \`arterm hq\` manually`);
}
