import { describe, expect, it } from "vitest";
import type { AgentDefinition } from "./agentRegistry.js";
import {
  type TeamMember,
  buildRosterPrompt,
  buildTeamDecomposePrompt,
  memberIsolation,
  parseAssignments,
  parseRoster,
} from "./team.js";
import type { Tool } from "./types.js";

const defs: AgentDefinition[] = [
  {
    name: "auditor",
    description: "security audits",
    instruction: "Audit the code for security issues.",
    tools: ["read", "grep"],
    source: "project",
  },
];

function tool(name: string, category?: Tool["category"], mutating?: boolean): Tool {
  return {
    name,
    description: "",
    parameters: {},
    permission: "allow",
    category,
    mutating,
    execute: async () => ({ output: "" }),
  };
}

describe("parseRoster", () => {
  it("adopts a matching definition's instruction and tools", () => {
    const roster = parseRoster('[{"name": "Auditor"}]', defs, 4);
    expect(roster).toHaveLength(1);
    const m = roster[0] as TeamMember;
    expect(m.id).toBe("m1-auditor");
    expect(m.adhoc).toBe(false);
    expect(m.instruction).toContain("security");
    expect(m.toolNames).toEqual(["read", "grep"]);
  });

  it("accepts ad-hoc members with an instruction, drops those without", () => {
    const raw =
      '[{"name": "docs-writer", "description": "writes docs", "instruction": "Write the docs."},' +
      ' {"name": "ghost"}]';
    const roster = parseRoster(raw, defs, 4);
    expect(roster).toHaveLength(1);
    const m = roster[0] as TeamMember;
    expect(m.adhoc).toBe(true);
    expect(m.name).toBe("docs-writer");
    expect(m.description).toBe("writes docs");
  });

  it("dedupes names and caps at the fanout", () => {
    const raw =
      '[{"name": "a", "instruction": "x"}, {"name": "a", "instruction": "y"},' +
      ' {"name": "b", "instruction": "x"}, {"name": "c", "instruction": "x"}]';
    expect(parseRoster(raw, [], 2).map((m) => m.name)).toEqual(["a", "b"]);
  });

  it("falls back to a built-in implementer + reviewer pair on garbage", () => {
    for (const raw of ["not json", "[]", '["strings"]']) {
      const roster = parseRoster(raw, defs, 4);
      expect(roster.map((m) => m.name)).toEqual(["implementer", "reviewer"]);
      expect(roster.every((m) => m.instruction.length > 0)).toBe(true);
    }
  });
});

describe("parseAssignments", () => {
  const roster = parseRoster(
    '[{"name": "a", "instruction": "x"}, {"name": "b", "instruction": "y"}]',
    [],
    4,
  );

  it("matches members by name", () => {
    const out = parseAssignments('[{"member": "B", "task": "do the thing"}]', roster, 4);
    expect(out).toHaveLength(1);
    expect(out[0]?.member.name).toBe("b");
    expect(out[0]?.task).toBe("do the thing");
  });

  it("falls back round-robin for unknown/missing member names", () => {
    const out = parseAssignments('[{"task": "t1"}, {"member": "zzz", "task": "t2"}]', roster, 4);
    expect(out.map((a) => a.member.name)).toEqual(["a", "b"]);
  });

  it("returns [] for garbage or an empty array and caps at the fanout", () => {
    expect(parseAssignments("nope", roster, 4)).toEqual([]);
    expect(parseAssignments("[]", roster, 4)).toEqual([]);
    const many = '[{"task":"1"},{"task":"2"},{"task":"3"}]';
    expect(parseAssignments(many, roster, 2)).toHaveLength(2);
  });
});

describe("memberIsolation", () => {
  it("read-only members share the cwd", () => {
    expect(memberIsolation([tool("read", "read"), tool("grep", "read")])).toBe("none");
  });

  it("any mutating/edit/execute tool means worktree isolation", () => {
    expect(memberIsolation([tool("read", "read"), tool("edit", "edit")])).toBe("worktree");
    expect(memberIsolation([tool("bash", "execute")])).toBe("worktree");
    expect(memberIsolation([tool("write", "read", true)])).toBe("worktree");
    // No category declared defaults to "execute" → isolate.
    expect(memberIsolation([tool("mystery")])).toBe("worktree");
  });
});

describe("prompts", () => {
  it("roster prompt lists the definition catalog and the fanout", () => {
    const prompt = buildRosterPrompt("ship the feature", defs, 3, "focus on tests");
    expect(prompt).toContain("auditor — security audits");
    expect(prompt).toContain("up to 3");
    expect(prompt).toContain("focus on tests");
  });

  it("decompose prompt lists members and demands disjoint file ownership", () => {
    const roster = parseRoster('[{"name": "auditor"}]', defs, 4);
    const prompt = buildTeamDecomposePrompt("ship it", roster, 2, undefined, 4);
    expect(prompt).toContain("- auditor");
    expect(prompt).toContain("Round 2");
    expect(prompt).toContain("OWN files");
    expect(prompt).toContain("[]");
  });
});
