import { describe, expect, it, vi } from "vitest";
import { type AgentEvent, EventBus } from "./eventBus.js";
import { PermissionBroker, summarizeArgs } from "./permissionBroker.js";
import type { PermissionAsker, Tool } from "./types.js";

function tool(name: string, overrides: Partial<Tool> = {}): Tool {
  return {
    name,
    description: `${name} tool`,
    parameters: { type: "object" },
    permission: "ask",
    execute: async () => ({ output: "" }),
    ...overrides,
  } as Tool;
}

/** An asker that never settles on its own — the test drives the outcome. */
const neverSettles: PermissionAsker = () => new Promise(() => {});

describe("PermissionBroker", () => {
  it("denies until a host installs an asker (unchanged headless behaviour)", async () => {
    const broker = new PermissionBroker();
    await expect(broker.ask(tool("shell"), {})).resolves.toBe("deny");
    expect(broker.current()).toBeNull();
  });

  it("passes the local answer through and publishes the pending request", async () => {
    const broker = new PermissionBroker();
    let seen: { tool: string; args: Record<string, unknown> } | null = null;
    broker.setAsker(async (t, args) => {
      seen = { tool: t.name, args };
      return "allow_always";
    });

    await expect(broker.ask(tool("write_file"), { path: "a.ts" })).resolves.toBe("allow_always");
    expect(seen).toEqual({ tool: "write_file", args: { path: "a.ts" } });
    expect(broker.current()).toBeNull();
  });

  it("exposes the request while it waits, with the tool's own preview", () => {
    const broker = new PermissionBroker();
    broker.setAsker(neverSettles);
    void broker.ask(
      tool("write_file", {
        category: "edit",
        riskTier: "destructive",
        preview: (args) => `write ${String(args.path)}`,
      }),
      { path: "a.ts" },
    );

    expect(broker.current()).toMatchObject({
      tool: "write_file",
      preview: "write a.ts",
      category: "edit",
      riskTier: "destructive",
      args: { path: "a.ts" },
    });
  });

  it("lets a remote answer win and aborts the local prompt", async () => {
    const broker = new PermissionBroker();
    const dismissed = vi.fn();
    broker.setAsker(
      (_t, _args, signal) =>
        new Promise((resolve) => {
          signal?.addEventListener("abort", () => {
            dismissed();
            resolve("deny"); // the host's post-abort resolution must be ignored
          });
        }),
    );

    const answer = broker.ask(tool("shell"), { cmd: "ls" });
    const id = broker.current()?.id ?? "";
    expect(broker.answer(id, "allow")).toEqual({ ok: true });

    await expect(answer).resolves.toBe("allow");
    expect(dismissed).toHaveBeenCalledOnce();
    expect(broker.current()).toBeNull();
  });

  it("rejects a stale id so a late click cannot approve the next call", async () => {
    const broker = new PermissionBroker();
    let settleLocal: ((a: "allow" | "deny") => void) | undefined;
    broker.setAsker(
      () =>
        new Promise((resolve) => {
          settleLocal = resolve;
        }),
    );

    const first = broker.ask(tool("shell"), { cmd: "ls" });
    const firstId = broker.current()?.id ?? "";
    settleLocal?.("allow");
    await expect(first).resolves.toBe("allow");

    void broker.ask(tool("shell"), { cmd: "rm -rf /" });
    const secondId = broker.current()?.id ?? "";
    expect(secondId).not.toBe(firstId);

    const result = broker.answer(firstId, "allow");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/stale/);
    // The second request is still waiting, untouched.
    expect(broker.current()?.id).toBe(secondId);
  });

  it("rejects an answer when nothing is pending", () => {
    const broker = new PermissionBroker();
    expect(broker.answer("whatever", "allow")).toEqual({
      ok: false,
      error: "no permission request is pending",
    });
  });

  it("queues concurrent requests instead of orphaning the first", async () => {
    const broker = new PermissionBroker();
    const prompted: string[] = [];
    let settle: ((a: "allow" | "deny") => void) | undefined;
    broker.setAsker(
      (t) =>
        new Promise((resolve) => {
          prompted.push(t.name);
          settle = resolve;
        }),
    );

    const a = broker.ask(tool("first"), {});
    const b = broker.ask(tool("second"), {});

    // Only the head is prompted; the other waits its turn.
    expect(prompted).toEqual(["first"]);
    expect(broker.current()?.tool).toBe("first");
    expect(broker.queuedCount()).toBe(1);

    settle?.("allow");
    await expect(a).resolves.toBe("allow");
    expect(prompted).toEqual(["first", "second"]);
    expect(broker.current()?.tool).toBe("second");
    expect(broker.queuedCount()).toBe(0);

    settle?.("deny");
    await expect(b).resolves.toBe("deny");
    expect(broker.current()).toBeNull();
  });

  it("treats a throwing local asker as a deny rather than wedging the loop", async () => {
    const broker = new PermissionBroker();
    broker.setAsker(async () => {
      throw new Error("UI is gone");
    });
    await expect(broker.ask(tool("shell"), {})).resolves.toBe("deny");
    expect(broker.current()).toBeNull();
  });

  it("emits request/resolved events carrying who answered", async () => {
    const bus = new EventBus();
    const events: AgentEvent[] = [];
    bus.on((ev) => events.push(ev));
    const broker = new PermissionBroker(bus);
    broker.setAsker(neverSettles);

    void broker.ask(tool("shell", { preview: () => "run ls" }), { cmd: "ls" });
    const id = broker.current()?.id ?? "";
    broker.answer(id, "allow");

    expect(events.filter((e) => e.type !== "permission_queued")).toEqual([
      { type: "permission_request", id, tool: "shell", preview: "run ls", category: "execute" },
      { type: "permission_resolved", id, tool: "shell", answer: "allow", via: "remote" },
    ]);
  });

  it("announces the queue depth, so a fully blocked fleet never shows a stale count", async () => {
    const bus = new EventBus();
    const depths: number[] = [];
    bus.on((ev) => {
      if (ev.type === "permission_queued") depths.push(ev.queued);
    });
    const broker = new PermissionBroker(bus);
    let settle: ((a: "allow" | "deny") => void) | undefined;
    broker.setAsker(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    );

    // First goes active (depth 0), the next two land behind it.
    const a = broker.ask(tool("first"), {});
    broker.ask(tool("second"), {});
    broker.ask(tool("third"), {});
    expect(depths).toEqual([0, 1, 2]);

    // Promoting the next one shortens the queue — announced without any other
    // event happening, which is the whole point (a blocked fleet is silent).
    settle?.("allow");
    await expect(a).resolves.toBe("allow");
    expect(depths.at(-1)).toBe(1);

    settle?.("allow");
    await Promise.resolve();
    expect(depths.at(-1)).toBe(0);
    // Draining the last one clears the counter instead of leaving it at 0→stale.
    settle?.("allow");
    await Promise.resolve();
    expect(depths.at(-1)).toBe(0);
    expect(broker.current()).toBeNull();
  });

  it("tags requests with the sub-agent that raised them", async () => {
    const bus = new EventBus();
    const events: AgentEvent[] = [];
    bus.on((ev) => events.push(ev));
    const broker = new PermissionBroker(bus);
    broker.setAsker(neverSettles);

    void broker.askFor({ id: "f1-2", name: "explorer" })(tool("write_file"), { path: "a.ts" });

    // Both the published request and the event carry it: the prompt names the
    // worker, and the board can mark that row as blocked.
    expect(broker.current()?.origin).toEqual({ id: "f1-2", name: "explorer" });
    expect(events.find((e) => e.type === "permission_request")).toMatchObject({
      origin: { id: "f1-2", name: "explorer" },
    });
  });

  it("leaves the main agent's requests without an origin", () => {
    const broker = new PermissionBroker();
    broker.setAsker(neverSettles);
    void broker.ask(tool("shell"), {});
    expect(broker.current()?.origin).toBeUndefined();
  });
});

describe("summarizeArgs", () => {
  it("clips long string values and leaves the rest alone", () => {
    const out = summarizeArgs({ path: "a.ts", content: "x".repeat(900), count: 3 });
    expect(out.path).toBe("a.ts");
    expect(out.count).toBe(3);
    expect(String(out.content)).toMatch(/^x{500}… \(900 chars\)$/);
  });
});
