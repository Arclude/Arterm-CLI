import { execFile } from "node:child_process";
import { promises as nodeFs, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "./eventBus.js";
import { PermissionManager } from "./permissions.js";
import { availableRoles, roleInstruction, runFleet, runSubagent } from "./subagent.js";
import type { ChatProvider, Tool } from "./types.js";
import { VERDICT_TOOL_NAME, captureVerdict, decideVerdict, formatVerdictEcho } from "./verify.js";

const runCmd = promisify(execFile);
async function hasGit(): Promise<boolean> {
  try {
    await runCmd("git", ["--version"]);
    return true;
  } catch {
    return false;
  }
}
const gitAvailable = await hasGit();

/** Stub provider that immediately calls task_done with a fixed summary. */
function doneProvider(summary: string): ChatProvider {
  return {
    id: "stub",
    supportsNativeTools: () => true,
    listModels: async () => [],
    async *chat() {
      yield {
        type: "tool_call",
        call: { id: "1", name: "task_done", arguments: { summary } },
      };
      yield { type: "done" };
    },
  };
}

const taskDone: Tool = {
  name: "task_done",
  description: "",
  parameters: {},
  permission: "allow",
  category: "read",
  execute: async () => ({ output: "done" }),
};

describe("roles", () => {
  it("lists the preset roles", () => {
    expect(availableRoles()).toEqual([
      "reviewer",
      "researcher",
      "tester",
      "implementer",
      "explorer",
    ]);
  });

  it("returns an instruction for a known role, undefined otherwise", () => {
    expect(roleInstruction("reviewer")).toContain("code reviewer");
    expect(roleInstruction("nope")).toBeUndefined();
    expect(roleInstruction(undefined)).toBeUndefined();
  });
});

describe("runSubagent", () => {
  it("runs a sub-agent to completion and returns the task_done summary", async () => {
    // Stub provider: first turn calls task_done, then ends.
    let call = 0;
    const provider: ChatProvider = {
      id: "stub",
      supportsNativeTools: () => true,
      listModels: async () => [],
      async *chat() {
        call += 1;
        if (call === 1) {
          yield {
            type: "tool_call",
            call: { id: "1", name: "task_done", arguments: { summary: "fixed the bug" } },
          };
        }
        yield { type: "done" };
      },
    };

    const output = await runSubagent("fix the bug", {
      provider,
      model: "x",
      tools: [],
      permissions: new PermissionManager({}, "yolo"),
      ask: async () => "deny",
      cwd: process.cwd(),
      taskDone,
      maxSteps: 5,
    });

    expect(output).toBe("fixed the bug");
  });

  it("prepends a role instruction to the task prompt", async () => {
    let seenPrompt = "";
    const provider: ChatProvider = {
      id: "stub",
      supportsNativeTools: () => true,
      listModels: async () => [],
      async *chat(req) {
        const last = req.messages[req.messages.length - 1];
        if (last?.role === "user") seenPrompt = last.content;
        yield {
          type: "tool_call",
          call: { id: "1", name: "task_done", arguments: { summary: "ok" } },
        };
        yield { type: "done" };
      },
    };

    await runSubagent("review auth.ts", {
      provider,
      model: "x",
      tools: [],
      permissions: new PermissionManager({}, "yolo"),
      ask: async () => "deny",
      cwd: process.cwd(),
      taskDone,
      role: "reviewer",
      maxSteps: 3,
    });

    expect(seenPrompt).toContain("code reviewer");
    expect(seenPrompt).toContain("review auth.ts");
  });

  it("an explicit instruction wins over the role preset", async () => {
    let seenPrompt = "";
    const provider: ChatProvider = {
      id: "stub",
      supportsNativeTools: () => true,
      listModels: async () => [],
      async *chat(req) {
        const last = req.messages[req.messages.length - 1];
        if (last?.role === "user") seenPrompt = last.content;
        yield {
          type: "tool_call",
          call: { id: "1", name: "task_done", arguments: { summary: "ok" } },
        };
        yield { type: "done" };
      },
    };

    await runSubagent("review auth.ts", {
      provider,
      model: "x",
      tools: [],
      permissions: new PermissionManager({}, "yolo"),
      ask: async () => "deny",
      cwd: process.cwd(),
      taskDone,
      role: "reviewer",
      instruction: "CUSTOM MEMBER BRIEF",
      maxSteps: 3,
    });

    expect(seenPrompt).toContain("CUSTOM MEMBER BRIEF");
    expect(seenPrompt).not.toContain("code reviewer");
  });

  it("threads a systemPrompt into the member's agent", async () => {
    let systemSeen = "";
    const provider: ChatProvider = {
      id: "stub",
      supportsNativeTools: () => true,
      listModels: async () => [],
      async *chat(req) {
        const system = req.messages.find((m) => m.role === "system");
        if (system) systemSeen = system.content;
        yield {
          type: "tool_call",
          call: { id: "1", name: "task_done", arguments: { summary: "ok" } },
        };
        yield { type: "done" };
      },
    };

    await runSubagent("scan", {
      provider,
      model: "x",
      tools: [],
      permissions: new PermissionManager({}, "yolo"),
      ask: async () => "deny",
      cwd: process.cwd(),
      taskDone,
      systemPrompt: "You are TESTBOT, a security auditor.",
      maxSteps: 3,
    });

    expect(systemSeen).toContain("You are TESTBOT");
  });

  it("bridges whitelisted private-bus events through onEvent (no text deltas)", async () => {
    const provider: ChatProvider = {
      id: "stub",
      supportsNativeTools: () => true,
      listModels: async () => [],
      async *chat() {
        yield { type: "text", delta: "thinking..." };
        yield {
          type: "tool_call",
          call: { id: "1", name: "task_done", arguments: { summary: "ok" } },
        };
        yield { type: "done" };
      },
    };

    const bridged: AgentEvent["type"][] = [];
    await runSubagent("do it", {
      provider,
      model: "x",
      tools: [],
      permissions: new PermissionManager({}, "yolo"),
      ask: async () => "deny",
      cwd: process.cwd(),
      taskDone,
      maxSteps: 3,
      onEvent: (e) => bridged.push(e.type),
    });

    expect(bridged).toContain("tool_call");
    expect(bridged).not.toContain("text_delta");
    expect(bridged).not.toContain("turn_start");
  });

  it("surfaces a swallowed provider error instead of '(no output)'", async () => {
    // The agent loop converts provider throws into bus `error` events; on the
    // sub-agent's private bus those were invisible (seen live as a 401-quota
    // fleet where every member "produced no output").
    const provider: ChatProvider = {
      id: "stub",
      supportsNativeTools: () => true,
      listModels: async () => [],
      // biome-ignore lint/correctness/useYield: the provider fails before yielding
      async *chat() {
        throw new Error("/chat/completions failed: 401 quota exhausted");
      },
    };

    const output = await runSubagent("do anything", {
      provider,
      model: "x",
      tools: [],
      permissions: new PermissionManager({}, "yolo"),
      ask: async () => "deny",
      cwd: process.cwd(),
      taskDone,
      maxSteps: 2,
    });

    expect(output).toContain("sub-agent failed:");
    expect(output).toContain("401");

    // And the fleet marks such a member as errored, not silently done.
    const results = await runFleet([{ task: "A", id: "m1" }], {
      provider,
      model: "x",
      tools: [],
      permissions: new PermissionManager({}, "yolo"),
      ask: async () => "deny",
      cwd: process.cwd(),
      taskDone,
      maxSteps: 2,
    });
    expect(results[0]?.error).toBe(true);
    expect(results[0]?.output).toContain("401");
  });
});

describe("runFleet", () => {
  const base = {
    provider: doneProvider("completed"),
    model: "x",
    tools: [] as Tool[],
    permissions: new PermissionManager({}, "yolo" as const),
    ask: async () => "deny" as const,
    cwd: process.cwd(),
    taskDone,
    maxSteps: 3,
  };

  it("runs tasks concurrently and returns results in input order", async () => {
    const results = await runFleet([{ task: "A" }, { task: "B" }, { task: "C" }], {
      ...base,
      concurrency: 2,
    });
    expect(results.map((r) => r.task)).toEqual(["A", "B", "C"]);
    expect(results.every((r) => r.output === "completed")).toBe(true);
  });

  it("invokes onStart/onDone once per task", async () => {
    const starts: number[] = [];
    const dones: number[] = [];
    await runFleet([{ task: "A" }, { task: "B" }], {
      ...base,
      onStart: (i) => starts.push(i),
      onDone: (i) => dones.push(i),
    });
    expect(starts.sort()).toEqual([0, 1]);
    expect(dones.sort()).toEqual([0, 1]);
  });

  it("does not create worktrees when cwd is not a git repo (graceful fallback)", async () => {
    const dir = realpathSync(await nodeFs.mkdtemp(join(tmpdir(), "arterm-nogit-")));
    const worktrees: string[] = [];
    const results = await runFleet([{ task: "A" }, { task: "B" }], {
      ...base,
      cwd: dir,
      isolation: "worktree",
      onWorktree: (_i, info) => worktrees.push(info.path),
    });
    // No git repo → isolation skipped; tasks still complete in the shared cwd.
    expect(worktrees).toHaveLength(0);
    expect(results.map((r) => r.task)).toEqual(["A", "B"]);
    await nodeFs.rm(dir, { recursive: true, force: true });
  });

  it.skipIf(!gitAvailable)("gives each worker a distinct worktree under isolation", async () => {
    const repo = realpathSync(await nodeFs.mkdtemp(join(tmpdir(), "arterm-fleet-git-")));
    await runCmd("git", ["init"], { cwd: repo });
    await runCmd("git", ["config", "user.email", "t@example.com"], { cwd: repo });
    await runCmd("git", ["config", "user.name", "Test"], { cwd: repo });
    await nodeFs.writeFile(join(repo, "seed.txt"), "seed\n");
    await runCmd("git", ["add", "-A"], { cwd: repo });
    await runCmd("git", ["commit", "-m", "init"], { cwd: repo });

    const worktrees: string[] = [];
    await runFleet([{ task: "A" }, { task: "B" }], {
      ...base,
      cwd: repo,
      isolation: "worktree",
      onWorktree: (_i, info) => worktrees.push(info.path),
    });

    expect(worktrees).toHaveLength(2);
    expect(new Set(worktrees).size).toBe(2); // distinct worktrees
    expect(worktrees.every((p) => p !== repo)).toBe(true); // none is the base repo
    // Worktrees were cleaned up (only the main worktree remains).
    const { stdout } = await runCmd("git", ["worktree", "list"], { cwd: repo });
    expect(stdout.split("\n").filter((l) => l.trim()).length).toBe(1);
    await nodeFs.rm(repo, { recursive: true, force: true });
  });

  it("per-task tool overrides reach the right worker", async () => {
    let probed = 0;
    const probe: Tool = {
      name: "probe",
      description: "",
      parameters: {},
      permission: "allow",
      category: "read",
      execute: async () => {
        probed += 1;
        return { output: "probed" };
      },
    };
    let call = 0;
    const provider: ChatProvider = {
      id: "stub",
      supportsNativeTools: () => true,
      listModels: async () => [],
      async *chat() {
        call += 1;
        if (call === 1) {
          yield { type: "tool_call", call: { id: "1", name: "probe", arguments: {} } };
          yield {
            type: "tool_call",
            call: { id: "2", name: "task_done", arguments: { summary: "ok" } },
          };
        }
        yield { type: "done" };
      },
    };

    // The fleet-wide tool set is empty; only the per-task override carries `probe`.
    const results = await runFleet([{ task: "A", id: "m1", tools: [probe] }], {
      ...base,
      provider,
    });

    expect(probed).toBe(1);
    expect(results[0]?.id).toBe("m1");
    expect(results[0]?.error).toBeUndefined();
  });

  it.skipIf(!gitAvailable)(
    "per-task worktree isolation works with a fleet-wide shared cwd",
    async () => {
      const repo = realpathSync(await nodeFs.mkdtemp(join(tmpdir(), "arterm-team-iso-")));
      await runCmd("git", ["init"], { cwd: repo });
      await runCmd("git", ["config", "user.email", "t@example.com"], { cwd: repo });
      await runCmd("git", ["config", "user.name", "Test"], { cwd: repo });
      await nodeFs.writeFile(join(repo, "seed.txt"), "seed\n");
      await runCmd("git", ["add", "-A"], { cwd: repo });
      await runCmd("git", ["commit", "-m", "init"], { cwd: repo });

      const worktrees: string[] = [];
      await runFleet(
        [
          { task: "writer", isolation: "worktree" },
          { task: "reader", isolation: "none" },
        ],
        { ...base, cwd: repo, onWorktree: (_i, info) => worktrees.push(info.path) },
      );

      expect(worktrees).toHaveLength(1);
      await nodeFs.rm(repo, { recursive: true, force: true });
    },
  );

  it.skipIf(!gitAvailable)("flags a member whose worktree cannot be created", async () => {
    const repo = realpathSync(await nodeFs.mkdtemp(join(tmpdir(), "arterm-team-err-")));
    await runCmd("git", ["init"], { cwd: repo });
    await runCmd("git", ["config", "user.email", "t@example.com"], { cwd: repo });
    await runCmd("git", ["config", "user.name", "Test"], { cwd: repo });
    await nodeFs.writeFile(join(repo, "seed.txt"), "seed\n");
    await runCmd("git", ["add", "-A"], { cwd: repo });
    await runCmd("git", ["commit", "-m", "init"], { cwd: repo });
    // Pre-create the branch the worker will want, forcing createWorktree to fail.
    await runCmd("git", ["branch", "arterm/fleet/clash"], { cwd: repo });

    const results = await runFleet([{ task: "A", id: "clash" }], {
      ...base,
      cwd: repo,
      isolation: "worktree",
    });

    expect(results[0]?.error).toBe(true);
    expect(results[0]?.output).toContain("sub-agent failed");
    await nodeFs.rm(repo, { recursive: true, force: true });
  });
});

/**
 * The verdict channel, proven through the real `runSubagent`. These are the
 * regression tests for the old text check (`/^\s*PASS\b/i` on the return string),
 * which read every infrastructure failure as a rejection.
 */
describe("runSubagent as a review channel", () => {
  // core cannot import @arterm/tools (the dependency direction is one-way), so
  // this mirrors submitVerdictTool: same name, same allow/read, same echo.
  const verdictTool: Tool = {
    name: VERDICT_TOOL_NAME,
    description: "",
    parameters: {},
    permission: "allow",
    category: "read",
    execute: async (args) => formatVerdictEcho(args),
  };

  const base = {
    model: "x",
    tools: [],
    permissions: new PermissionManager({}, "yolo"),
    ask: async () => "deny" as const,
    cwd: process.cwd(),
    taskDone: verdictTool,
    maxSteps: 2,
  };

  it("delivers an explicit rejection with its items", async () => {
    const provider: ChatProvider = {
      id: "stub",
      supportsNativeTools: () => true,
      listModels: async () => [],
      async *chat() {
        yield {
          type: "tool_call",
          call: {
            id: "1",
            name: "submit_verdict",
            arguments: { pass: false, summary: "no parser", mustFix: ["add src/parser.ts"] },
          },
        };
        yield { type: "done" };
      },
    };
    const capture = captureVerdict();
    const out = await runSubagent("review it", { ...base, provider, onEvent: capture.onEvent });
    const decision = decideVerdict(capture.result());
    expect(decision).toMatchObject({ pass: false, judged: true, mustFix: ["add src/parser.ts"] });
    // The tool doubles as the run's terminal signal, so its summary is the output.
    expect(out).toBe("no parser");
  });

  it("ends the review at the verdict, without a second step", async () => {
    let calls = 0;
    const provider: ChatProvider = {
      id: "stub",
      supportsNativeTools: () => true,
      listModels: async () => [],
      async *chat() {
        calls += 1;
        if (calls === 1) {
          yield {
            type: "tool_call",
            call: { id: "1", name: "submit_verdict", arguments: { pass: true, summary: "fine" } },
          };
        } else {
          yield { type: "text", delta: "reviewed" };
        }
        yield { type: "done" };
      },
    };
    const capture = captureVerdict();
    await runSubagent("review it", { ...base, provider, maxSteps: 4, onEvent: capture.onEvent });
    expect(capture.result().verdict).toMatchObject({ pass: true });
    // The verdict tool is the run's terminal signal: one step, not four.
    expect(calls).toBeLessThanOrEqual(2);
  });

  it("yields no verdict when the provider is dead, so the caller accepts", async () => {
    // The bug this replaces: `"sub-agent failed: 401 …"` does not start with PASS,
    // so a dead API key was scored as two rejections and stopped the run —
    // blaming the worker for an auth failure.
    const provider: ChatProvider = {
      id: "stub",
      supportsNativeTools: () => true,
      listModels: async () => [],
      // biome-ignore lint/correctness/useYield: the provider fails before yielding
      async *chat() {
        throw new Error("/chat/completions failed: 401 quota exhausted");
      },
    };
    const capture = captureVerdict();
    const out = await runSubagent("review it", { ...base, provider, onEvent: capture.onEvent });
    expect(out).toContain("sub-agent failed:");
    expect(capture.result().verdict).toBeUndefined();
    expect(decideVerdict(capture.result())).toMatchObject({ pass: true, judged: false });
  });

  it("yields no verdict when the judge only writes prose", async () => {
    // Prose is not a channel. A model that says "FAIL: broken" without calling
    // the tool has not delivered a verdict, and the claim is accepted unreviewed.
    const provider: ChatProvider = {
      id: "stub",
      supportsNativeTools: () => true,
      listModels: async () => [],
      async *chat() {
        yield { type: "text", delta: "FAIL: this is completely broken" };
        yield { type: "done" };
      },
    };
    const capture = captureVerdict();
    await runSubagent("review it", { ...base, provider, onEvent: capture.onEvent });
    const c = capture.result();
    expect(c.verdict).toBeUndefined();
    expect(c.reason).toBe("not-submitted");
    expect(decideVerdict(c).pass).toBe(true);
  });

  it("yields no verdict when the payload is unreadable", async () => {
    let calls = 0;
    const provider: ChatProvider = {
      id: "stub",
      supportsNativeTools: () => true,
      listModels: async () => [],
      async *chat() {
        calls += 1;
        if (calls === 1) {
          yield {
            type: "tool_call",
            call: { id: "1", name: "submit_verdict", arguments: { pass: "maybe", summary: "hm" } },
          };
        } else {
          yield { type: "text", delta: "gave up" };
        }
        yield { type: "done" };
      },
    };
    const capture = captureVerdict();
    await runSubagent("review it", { ...base, provider, onEvent: capture.onEvent });
    expect(capture.result().malformed).toBe(1);
    expect(decideVerdict(capture.result()).pass).toBe(true);
  });
});

describe("runSubagent truncation", () => {
  it("marks a result that stopped at a cap as unfinished", async () => {
    // A worker that ran out of iterations used to report its last message as if it
    // were an answer, so the parent could not tell truncation from completion.
    const provider: ChatProvider = {
      id: "stub",
      supportsNativeTools: () => true,
      listModels: async () => [],
      async *chat() {
        yield { type: "text", delta: "still working on it" };
        yield { type: "tool_call", call: { id: "t", name: "noop", arguments: {} } };
        yield { type: "done" };
      },
    };
    const noop: Tool = {
      name: "noop",
      description: "",
      parameters: {},
      permission: "allow",
      category: "read",
      execute: async () => ({ output: "ok" }),
    };
    const out = await runSubagent("keep going", {
      provider,
      model: "x",
      tools: [noop],
      permissions: new PermissionManager({}, "yolo"),
      ask: async () => "deny",
      cwd: process.cwd(),
      taskDone,
      maxSteps: 1,
      maxIterations: 2,
    });
    expect(out).toContain("[truncated: iterations cap 2 reached");
    expect(out).toContain("still working on it");
  });
});

/**
 * Config that reaches the main agent has to reach a sub-agent too. Each of these
 * stopped at the boundary: the parent honored a limit while its workers — four at
 * a time — did not, which is the same shape as a limit that does not exist.
 */
describe("runSubagent inherits the parent's limits", () => {
  it("honors a turn token budget", async () => {
    const provider: ChatProvider = {
      id: "stub",
      supportsNativeTools: () => true,
      listModels: async () => [],
      async *chat() {
        yield { type: "text", delta: "working" };
        yield { type: "tool_call", call: { id: "t", name: "noop", arguments: {} } };
        yield {
          type: "done",
          usage: { promptTokens: 900, completionTokens: 100, totalTokens: 1000 },
        };
      },
    };
    const noop: Tool = {
      name: "noop",
      description: "",
      parameters: {},
      permission: "allow",
      category: "read",
      execute: async () => ({ output: "ok" }),
    };
    const limits: string[] = [];
    const out = await runSubagent("keep going", {
      provider,
      model: "x",
      tools: [noop],
      permissions: new PermissionManager({}, "yolo"),
      ask: async () => "deny",
      cwd: process.cwd(),
      taskDone,
      maxSteps: 1,
      turnTokenBudget: 1500,
      onEvent: (e) => {
        if (e.type === "run_limit") limits.push(e.kind);
      },
    });

    expect(limits).toContain("tokens");
    expect(out).toContain("[truncated: tokens cap 1500");
  });
});

describe("runSubagent loop detection", () => {
  it("forwards loopDetect to the sub-agent and bridges loop events to the parent", async () => {
    // Repeats the identical call forever — only the loop detector ends this.
    const provider: ChatProvider = {
      id: "stub",
      supportsNativeTools: () => true,
      listModels: async () => [],
      async *chat() {
        yield { type: "tool_call", call: { id: "r", name: "noop", arguments: { n: 1 } } };
        yield { type: "done" };
      },
    };
    const noop: Tool = {
      name: "noop",
      description: "",
      parameters: {},
      permission: "allow",
      category: "read",
      execute: async () => ({ output: "ok" }),
    };
    const seen: AgentEvent["type"][] = [];
    await runSubagent("spin", {
      provider,
      model: "x",
      tools: [noop],
      permissions: new PermissionManager({}, "yolo"),
      ask: async () => "deny",
      cwd: process.cwd(),
      taskDone,
      maxSteps: 2,
      maxIterations: 10,
      loopDetect: { steerAfter: 2, cutAfter: 3 },
      onEvent: (e) => seen.push(e.type),
    });
    expect(seen).toContain("loop_detected");
    expect(seen).toContain("loop_cut");
  });
});
