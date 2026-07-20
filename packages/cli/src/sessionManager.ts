import type { Session } from "@arterm/tui";
import type { StatusServer } from "./statusServer.js";

/** One interactive session and the resources the CLI must release for it. */
export interface CliManagedSession {
  /** Also the status-server sessionId — the desktop keys dashboard rows by it. */
  id: string;
  session: Session;
  statusServer?: StatusServer;
  persist(): Promise<void>;
  digest(): Promise<void>;
}

/** Owns every interactive session in this process, in creation order. */
export class SessionManager {
  private readonly sessions: CliManagedSession[] = [];

  constructor(
    first: CliManagedSession,
    private readonly factory: () => Promise<CliManagedSession>,
  ) {
    this.sessions.push(first);
  }

  all(): readonly CliManagedSession[] {
    return this.sessions;
  }

  async create(): Promise<CliManagedSession> {
    const created = await this.factory();
    this.sessions.push(created);
    return created;
  }

  /**
   * Release one session (Ctrl+X in the TUI): status server first — external
   * observers must not see a half-closed session — then digest and persist.
   * The remaining sessions keep running untouched.
   */
  async close(id: string, onDigestError?: (err: Error) => void): Promise<void> {
    const idx = this.sessions.findIndex((s) => s.id === id);
    if (idx < 0) return;
    const [closed] = this.sessions.splice(idx, 1);
    if (!closed) return;
    await closed.statusServer?.close();
    try {
      await closed.digest();
    } catch (err) {
      onDigestError?.(err as Error);
    }
    await closed.persist();
  }

  /**
   * Release every session: status servers first (external observers stop
   * seeing half-closed sessions), then digests and persists sequentially —
   * the sessions share one project memory store, and concurrent writes to
   * it are not safe.
   */
  async closeAll(onDigestError?: (err: Error) => void): Promise<void> {
    for (const s of this.sessions) await s.statusServer?.close();
    for (const s of this.sessions) {
      try {
        await s.digest();
      } catch (err) {
        onDigestError?.(err as Error);
      }
      await s.persist();
    }
  }
}
