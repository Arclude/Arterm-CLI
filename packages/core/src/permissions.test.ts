import { describe, expect, it, vi } from "vitest";
import { RiskArbiter } from "./arbiter.js";
import { PermissionManager } from "./permissions.js";
import type { Tool } from "./types.js";

const tool = (name: string, permission: Tool["permission"], category?: Tool["category"]): Tool => ({
  name,
  description: "",
  parameters: {},
  permission,
  category,
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

  it("yolo approves safe calls without asking", async () => {
    const ask = vi.fn();
    const pm = new PermissionManager({}, "yolo");
    const d = await pm.check(tool("bash", "ask"), {}, ask as never);
    expect(d.allowed).toBe(true);
    expect(ask).not.toHaveBeenCalled();
  });

  it("yolo stays fail-closed: the arbiter still denies critical calls", async () => {
    const ask = vi.fn();
    const pm = new PermissionManager({}, "yolo", new RiskArbiter());
    const d = await pm.check(tool("bash", "ask", "execute"), { command: "rm -rf /" }, ask as never);
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/critical/);
    expect(ask).not.toHaveBeenCalled();
  });

  it("yolo still honors a tool-level deny", async () => {
    const ask = vi.fn();
    const pm = new PermissionManager({}, "yolo");
    const d = await pm.check(tool("rm", "deny"), {}, ask as never);
    expect(d.allowed).toBe(false);
    expect(ask).not.toHaveBeenCalled();
  });

  it("confirmDestructive re-prompts for destructive tools even under yolo", async () => {
    const ask = vi.fn().mockResolvedValue("deny");
    const pm = new PermissionManager({}, "yolo", new RiskArbiter(), true);
    const destructive: Tool = { ...tool("bash", "ask", "execute"), riskTier: "destructive" };
    // A benign command would normally pass silently in yolo, but the gate forces a prompt.
    const d = await pm.check(destructive, { command: "ls" }, ask);
    expect(ask).toHaveBeenCalledOnce();
    expect(d.allowed).toBe(false);
    // A non-destructive tool is still silent under yolo.
    const safe = await pm.check(tool("write", "ask", "edit"), { path: "a.ts" }, ask);
    expect(safe.allowed).toBe(true);
  });

  it("auto mode approves edits silently but still asks for execute tools without an arbiter", async () => {
    const ask = vi.fn().mockResolvedValue("deny");
    const pm = new PermissionManager({}, "auto");

    const edit = await pm.check(tool("write", "ask", "edit"), {}, ask);
    expect(edit.allowed).toBe(true);
    expect(ask).not.toHaveBeenCalled();

    // No arbiter to screen the command → execute still prompts (fail-safe).
    const exec = await pm.check(tool("bash", "ask", "execute"), {}, ask);
    expect(ask).toHaveBeenCalledOnce();
    expect(exec.allowed).toBe(false);
  });

  it("auto mode + arbiter runs safe shell commands silently but escalates risky ones", async () => {
    const ask = vi.fn().mockResolvedValue("deny");
    const pm = new PermissionManager({}, "auto", new RiskArbiter());
    const bash: Tool = { ...tool("bash", "ask", "execute"), riskTier: "destructive" };

    // A routine command runs without a prompt, even though bash is destructive-tier.
    const safe = await pm.check(bash, { command: "ls -la" }, ask);
    expect(safe.allowed).toBe(true);
    expect(ask).not.toHaveBeenCalled();

    // A risky command is escalated to the human.
    const risky = await pm.check(bash, { command: "rm -rf node_modules" }, ask);
    expect(ask).toHaveBeenCalledOnce();
    expect(risky.allowed).toBe(false);
  });

  it("plan mode blocks edits/execute without asking but allows reads", async () => {
    const ask = vi.fn();
    const pm = new PermissionManager({}, "plan");

    const edit = await pm.check(tool("write", "ask", "edit"), {}, ask as never);
    expect(edit.allowed).toBe(false);
    expect(edit.reason).toMatch(/plan mode/);

    const read = await pm.check(tool("read", "allow", "read"), {}, ask as never);
    expect(read.allowed).toBe(true);
    expect(ask).not.toHaveBeenCalled();
  });

  it("setMode switches behavior at runtime", async () => {
    const ask = vi.fn().mockResolvedValue("deny");
    const pm = new PermissionManager();
    expect(pm.getMode()).toBe("ask");
    pm.setMode("auto");
    const d = await pm.check(tool("edit", "ask", "edit"), {}, ask);
    expect(d.allowed).toBe(true);
    expect(ask).not.toHaveBeenCalled();
  });

  it("with the Brain Arbiter, denies critical calls without asking", async () => {
    const ask = vi.fn();
    const pm = new PermissionManager({}, "auto", new RiskArbiter());
    const d = await pm.check(tool("bash", "ask", "execute"), { command: "rm -rf /" }, ask as never);
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/critical/);
    expect(ask).not.toHaveBeenCalled();
  });

  it("with the Brain Arbiter, escalates a risky edit in auto mode", async () => {
    const ask = vi.fn().mockResolvedValue("deny");
    const pm = new PermissionManager({}, "auto", new RiskArbiter());
    // A normal edit auto-approves in auto mode...
    const normal = await pm.check(tool("write", "ask", "edit"), { path: "a.ts" }, ask);
    expect(normal.allowed).toBe(true);
    expect(ask).not.toHaveBeenCalled();
    // ...but a sensitive-file edit is escalated to the human.
    const risky = await pm.check(tool("write", "ask", "edit"), { path: ".env" }, ask);
    expect(ask).toHaveBeenCalledOnce();
    expect(risky.allowed).toBe(false);
  });
});

describe("PermissionManager.evaluate", () => {
  const destructive = (name: string): Tool => ({
    ...tool(name, "ask", "execute"),
    riskTier: "destructive",
  });

  it("resolves the same outcome check() acts on", async () => {
    // The guarantee the explainer rests on: one ladder, two callers. If these
    // ever disagree, `permissions explain` is describing a policy nobody runs.
    const cases: Array<[Tool, Record<string, unknown>, PermissionManager]> = [
      [tool("read", "allow", "read"), {}, new PermissionManager()],
      [tool("write", "ask", "edit"), {}, new PermissionManager({}, "auto")],
      [tool("write", "ask", "edit"), {}, new PermissionManager({}, "plan")],
      [tool("rm", "deny"), {}, new PermissionManager({}, "yolo")],
      [
        tool("bash", "ask", "execute"),
        { command: "rm -rf /" },
        new PermissionManager({}, "auto", new RiskArbiter()),
      ],
    ];
    for (const [t, args, pm] of cases) {
      const evaluation = pm.evaluate(t, args);
      const ask = vi.fn().mockResolvedValue("deny");
      const decision = await pm.check(t, args, ask);
      if (evaluation.outcome === "prompt") {
        expect(ask).toHaveBeenCalledOnce();
      } else {
        expect(ask).not.toHaveBeenCalled();
        expect(decision.allowed).toBe(evaluation.outcome === "allow");
      }
    }
  });

  it("never executes the tool or writes an override", () => {
    const pm = new PermissionManager();
    const exploding: Tool = {
      ...tool("write", "ask", "edit"),
      execute: async () => {
        throw new Error("evaluate must not execute");
      },
    };
    expect(pm.evaluate(exploding, {}).outcome).toBe("prompt");
    expect(pm.snapshot()).toEqual({});
  });

  it("marks exactly one step as the decider", () => {
    const pm = new PermissionManager({}, "auto", new RiskArbiter());
    for (const [t, args] of [
      [tool("read", "allow", "read"), {}],
      [tool("bash", "ask", "execute"), { command: "ls" }],
      [tool("bash", "ask", "execute"), { command: "rm -rf /" }],
    ] as const) {
      const decided = pm.evaluate(t, args).trace.filter((s) => s.decided);
      expect(decided).toHaveLength(1);
    }
  });

  it("reports the rule that blocked, not just that something did", () => {
    const denied = new PermissionManager({ bash: "deny" }, "yolo").evaluate(
      tool("bash", "ask", "execute"),
      {},
    );
    expect(denied.outcome).toBe("deny");
    expect(denied.trace.at(-1)).toMatchObject({ rule: "tool-level", decided: true });
    expect(denied.overridden).toBe(true);

    const planned = new PermissionManager({}, "plan").evaluate(tool("write", "ask", "edit"), {});
    expect(planned.trace.at(-1)).toMatchObject({ rule: "mode:plan", decided: true });
    expect(planned.reason).toMatch(/read-only/);
  });

  it("explains why auto still prompts for shell without an arbiter", () => {
    const pm = new PermissionManager({}, "auto");
    const evaluation = pm.evaluate(tool("bash", "ask", "execute"), { command: "ls" });
    expect(evaluation.outcome).toBe("prompt");
    expect(evaluation.trace.map((s) => s.detail).join(" ")).toMatch(/no arbiter/i);
  });

  it("surfaces the destructive gate as its own step", () => {
    const pm = new PermissionManager({}, "yolo", undefined, true);
    const evaluation = pm.evaluate(destructive("drop_db"), {});
    expect(evaluation.outcome).toBe("prompt");
    expect(evaluation.riskTier).toBe("destructive");
    expect(evaluation.trace.some((s) => s.rule === "confirm-destructive")).toBe(true);
  });
});
