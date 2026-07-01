/**
 * Open a URL in the user's default browser — best-effort, non-blocking.
 *
 * Lifted out of `main.ts` so import-safe modules (e.g. `hqServer.ts`) can reuse it
 * without dragging `main.ts`'s top-level `main()` side-effect into their graph.
 */
export async function openBrowser(url: string): Promise<void> {
  try {
    const { spawn } = await import("node:child_process");
    if (process.platform === "win32") {
      // NOT `cmd /c start`: cmd treats `&` in the URL as a command separator, so a
      // multi-param URL gets truncated at the first `&`. rundll32 receives the whole
      // URL as a single argument and hands it to the default browser intact.
      spawn("rundll32", ["url.dll,FileProtocolHandler", url], {
        detached: true,
        stdio: "ignore",
      }).unref();
    } else {
      const cmd = process.platform === "darwin" ? "open" : "xdg-open";
      spawn(cmd, [url], { detached: true, stdio: "ignore" }).unref();
    }
  } catch {
    // Opening a browser is best-effort.
  }
}
