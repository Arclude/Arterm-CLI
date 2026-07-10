import { describe, expect, it } from "vitest";
import { looksLikeBigTask } from "./teamSuggest.js";

const FILLER = "lorem ipsum dolor sit amet consectetur adipiscing elit sed do ".repeat(4);

describe("looksLikeBigTask", () => {
  it("rejects short prompts outright", () => {
    expect(looksLikeBigTask("fix the login bug")).toBe(false);
    expect(looksLikeBigTask("- a\n- b\n- c")).toBe(false); // bulleted but tiny
  });

  it("accepts a long prompt with three or more enumerated items", () => {
    const prompt = `${FILLER}\n1. refactor the auth module\n2. add integration tests\n3. update the docs`;
    expect(looksLikeBigTask(prompt)).toBe(true);
    const dashed = `${FILLER}\n- refactor auth\n- add tests\n- update docs`;
    expect(looksLikeBigTask(dashed)).toBe(true);
  });

  it("accepts long prose with chained scopes or many sentences", () => {
    const chained = `Refactor the whole auth module ${FILLER} and then add tests, then wire the CI pipeline, then update all the docs so everything stays consistent.`;
    expect(looksLikeBigTask(chained)).toBe(true);
    const sentences =
      "Refactor the auth module completely for the new provider integration. Add integration tests covering all of the login flows. " +
      "Update the developer documentation with the new setup instructions and examples. Finally verify the whole pipeline builds cleanly on CI. " +
      "Make sure nothing in the plugin loader or the MCP manager regresses while you are doing all of this work.";
    expect(looksLikeBigTask(sentences)).toBe(true);
  });

  it("rejects a long single-scope prompt", () => {
    const single = `Please rename the variable oldName to newName across the file ${FILLER}`;
    expect(looksLikeBigTask(single)).toBe(false);
  });
});
