import { describe, expect, it, vi } from "vitest";
import { PermissionManager } from "./permissions.js";
import type { Tool } from "./types.js";

const tool = (name: string, permission: Tool["permission"]): Tool => ({
  name,
  description: "",
  parameters: {},
  permission,
  execute: async () => ({ output: "" }),
});

describe("PermissionManager", () => {
  it("auto-allows tools marked allow without asking", async () => {
    const ask = vi.fn();
    const pm = new PermissionManager();
    const d = await pm.check(tool("read", "allow"), {}, ask as never);
    expect(d.allowed).toBe(true);
    expect(ask).not.toHaveBeenCalled();
  });

  it("denies tools marked deny without asking", async () => {
    const ask = vi.fn();
    const pm = new PermissionManager();
    const d = await pm.check(tool("rm", "deny"), {}, ask as never);
    expect(d.allowed).toBe(false);
    expect(ask).not.toHaveBeenCalled();
  });

  it("asks for ask-level tools and honors a deny answer", async () => {
    const ask = vi.fn().mockResolvedValue("deny");
    const pm = new PermissionManager();
    const d = await pm.check(tool("write", "ask"), {}, ask);
    expect(ask).toHaveBeenCalledOnce();
    expect(d.allowed).toBe(false);
  });

  it("persists allow_always as an override", async () => {
    const ask = vi.fn().mockResolvedValue("allow_always");
    const pm = new PermissionManager();
    const write = tool("write", "ask");
    const d = await pm.check(write, {}, ask);
    expect(d.allowed).toBe(true);
    expect(d.persist).toBe(true);
    // Second call should not ask again.
    ask.mockClear();
    await pm.check(write, {}, ask);
    expect(ask).not.toHaveBeenCalled();
    expect(pm.snapshot().write).toBe("allow");
  });

  it("yolo bypasses everything", async () => {
    const ask = vi.fn();
    const pm = new PermissionManager({}, true);
    const d = await pm.check(tool("bash", "ask"), {}, ask as never);
    expect(d.allowed).toBe(true);
    expect(ask).not.toHaveBeenCalled();
  });
});
