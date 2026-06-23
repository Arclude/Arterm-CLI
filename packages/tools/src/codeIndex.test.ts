import { describe, expect, it } from "vitest";
import { CodeIndex } from "./codeIndex.js";

describe("CodeIndex", () => {
  it("ranks the most relevant document first", () => {
    const index = new CodeIndex();
    index.addDocument("auth.ts", "function login(user) {\n  return authenticate(user);\n}");
    index.addDocument("math.ts", "function add(a, b) {\n  return a + b;\n}");
    index.addDocument("notes.txt", "remember to buy milk and eggs");

    const hits = index.search("login authenticate user");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.path).toBe("auth.ts");
  });

  it("ranks a rare term highly via IDF", () => {
    const index = new CodeIndex();
    // "the" is common across all docs; "quasar" appears in only one.
    index.addDocument("a.ts", "the the the the value");
    index.addDocument("b.ts", "the the the the result");
    index.addDocument("c.ts", "the quasar the the the");

    const hits = index.search("quasar");
    expect(hits[0]?.path).toBe("c.ts");
  });

  it("returns the correct line and a non-empty snippet for a match", () => {
    const index = new CodeIndex();
    index.addDocument(
      "server.ts",
      "import http from 'http';\nconst PORT = 8080;\nexport function startServer() {}",
    );

    const hits = index.search("startServer");
    expect(hits.length).toBe(1);
    expect(hits[0]?.line).toBe(3);
    expect(hits[0]?.snippet).toContain("startServer");
    expect(hits[0]?.snippet.length).toBeGreaterThan(0);
  });

  it("returns [] for an empty query", () => {
    const index = new CodeIndex();
    index.addDocument("a.ts", "some content here");
    expect(index.search("")).toEqual([]);
    expect(index.search("   ")).toEqual([]);
  });

  it("returns [] when nothing matches", () => {
    const index = new CodeIndex();
    index.addDocument("a.ts", "alpha beta gamma");
    expect(index.search("zzzznotpresent")).toEqual([]);
  });

  it("reports the corpus size", () => {
    const index = new CodeIndex();
    expect(index.size).toBe(0);
    index.addDocument("a.ts", "one");
    index.addDocument("b.ts", "two");
    expect(index.size).toBe(2);
  });
});
