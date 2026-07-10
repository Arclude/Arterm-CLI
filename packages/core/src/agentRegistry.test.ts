import { afterEach, describe, expect, it } from "vitest";
import {
  type AgentDefinition,
  getAgentDefinition,
  listAgentDefinitions,
  registerAgentDefinitions,
} from "./agentRegistry.js";
import { availableRoles, roleInstruction } from "./subagent.js";

const auditor: AgentDefinition = {
  name: "auditor",
  description: "security audits",
  instruction: "Audit the code for security issues.",
  tools: ["read", "grep"],
  source: "project",
};

afterEach(() => registerAgentDefinitions([]));

describe("agentRegistry", () => {
  it("registers, lists, and looks up case-insensitively", () => {
    registerAgentDefinitions([auditor]);
    expect(listAgentDefinitions()).toHaveLength(1);
    expect(getAgentDefinition("AUDITOR")?.instruction).toContain("security");
    expect(getAgentDefinition("nope")).toBeUndefined();
  });

  it("replaces the whole set on re-register", () => {
    registerAgentDefinitions([auditor]);
    registerAgentDefinitions([]);
    expect(listAgentDefinitions()).toHaveLength(0);
  });

  it("feeds roleInstruction: a user definition wins over a built-in role", () => {
    registerAgentDefinitions([
      { ...auditor, name: "reviewer", instruction: "Custom reviewer brief." },
    ]);
    expect(roleInstruction("reviewer")).toBe("Custom reviewer brief.");
    // Unregistered roles still fall back to the built-in preset.
    expect(roleInstruction("tester")).toContain("test engineer");
  });

  it("extends availableRoles with registered definitions (deduped)", () => {
    registerAgentDefinitions([auditor, { ...auditor, name: "reviewer" }]);
    const roles = availableRoles();
    expect(roles).toContain("auditor");
    expect(roles.filter((r) => r === "reviewer")).toHaveLength(1);
    expect(roles).toContain("implementer");
  });
});
