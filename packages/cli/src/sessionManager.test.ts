import type { Session } from "@arterm/tui";
import { describe, expect, it, vi } from "vitest";
import { type CliManagedSession, SessionManager } from "./sessionManager.js";

function makeManaged(id: string, log: string[]): CliManagedSession {
  return {
    id,
    session: {} as Session,
    statusServer: {
      url: "http://127.0.0.1:0",
      port: 0,
      token: "t",
      close: vi.fn(async () => {
        log.push(`close:${id}`);
      }),
    },
    persist: async () => {
      log.push(`persist:${id}`);
    },
    digest: async () => {
      log.push(`digest:${id}`);
    },
  };
}

describe("SessionManager", () => {
  it("appends factory-created sessions in order", async () => {
    const log: string[] = [];
    let n = 0;
    const manager = new SessionManager(makeManaged("s0", log), async () =>
      makeManaged(`s${++n}`, log),
    );
    await manager.create();
    await manager.create();
    expect(manager.all().map((s) => s.id)).toEqual(["s0", "s1", "s2"]);
  });

  it("closeAll shuts servers first, then digests+persists sequentially", async () => {
    const log: string[] = [];
    const manager = new SessionManager(makeManaged("a", log), async () => makeManaged("b", log));
    await manager.create();
    await manager.closeAll();
    expect(log).toEqual(["close:a", "close:b", "digest:a", "persist:a", "digest:b", "persist:b"]);
  });

  it("close(id) releases just that session and leaves the rest running", async () => {
    const log: string[] = [];
    const manager = new SessionManager(makeManaged("a", log), async () => makeManaged("b", log));
    await manager.create();
    await manager.close("a");
    expect(log).toEqual(["close:a", "digest:a", "persist:a"]);
    expect(manager.all().map((s) => s.id)).toEqual(["b"]);
    // Unknown id is a no-op, not an error.
    await manager.close("ghost");
    expect(manager.all().map((s) => s.id)).toEqual(["b"]);
  });

  it("a failing digest reports the error and still persists every session", async () => {
    const log: string[] = [];
    const bad = makeManaged("bad", log);
    bad.digest = async () => {
      throw new Error("digest boom");
    };
    const manager = new SessionManager(bad, async () => makeManaged("ok", log));
    await manager.create();
    const errors: string[] = [];
    await manager.closeAll((err) => errors.push(err.message));
    expect(errors).toEqual(["digest boom"]);
    expect(log).toContain("persist:bad");
    expect(log).toContain("persist:ok");
    expect(log).toContain("digest:ok");
  });
});
