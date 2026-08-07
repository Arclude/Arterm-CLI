import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { globTool } from "./glob.js";
import { grepTool } from "./grep.js";
import { ignorePatterns } from "./ignore.js";

let dir: string;
const ctx = () => ({ cwd: dir });

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), "arterm-ignore-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("ignorePatterns", () => {
  it("always excludes .git and node_modules, gitignore or not", async () => {
    const patterns = await ignorePatterns(dir);
    expect(patterns).toContain("**/.git/**");
    expect(patterns).toContain("**/node_modules/**");
  });

  it("falls back to the usual build output when there is no .gitignore", async () => {
    // The old hardcoded list was `node_modules`, `dist`, `.git` — the set that
    // happens to matter in a TypeScript repo and nowhere else.
    const patterns = await ignorePatterns(dir);
    expect(patterns).toContain("**/target/**"); // Rust
    expect(patterns).toContain("**/.next/**"); // Next.js
    expect(patterns).toContain("**/.venv/**"); // Python
    expect(patterns).toContain("**/coverage/**");
  });

  it("reads the project's own .gitignore instead", async () => {
    await fs.writeFile(join(dir, ".gitignore"), "generated/\n*.log\n");
    const patterns = await ignorePatterns(dir);
    expect(patterns).toContain("**/generated");
    expect(patterns).toContain("**/*.log");
  });

  it("skips comments and blank lines", async () => {
    await fs.writeFile(join(dir, ".gitignore"), "# a comment\n\n  \nreal/\n");
    const patterns = await ignorePatterns(dir);
    expect(patterns.some((p) => p.includes("comment"))).toBe(false);
    expect(patterns).toContain("**/real");
  });

  it("drops a negation rather than approximating it", async () => {
    // `!keep.txt` re-includes a file. Translating it wrong would hide a file
    // the user explicitly un-ignored — a much more expensive mistake than
    // ignoring too little.
    await fs.writeFile(join(dir, ".gitignore"), "logs/\n!logs/keep.txt\n");
    const patterns = await ignorePatterns(dir);
    expect(patterns.some((p) => p.includes("keep.txt"))).toBe(false);
  });

  it("anchors a rooted rule and floats a bare one", async () => {
    await fs.writeFile(join(dir, ".gitignore"), "/only-at-root\nanywhere\n");
    const patterns = await ignorePatterns(dir);
    expect(patterns).toContain("only-at-root");
    expect(patterns).toContain("**/anywhere");
  });
});

describe("grep and glob honour it", () => {
  beforeEach(async () => {
    await fs.mkdir(join(dir, "src"), { recursive: true });
    await fs.mkdir(join(dir, "target"), { recursive: true });
    await fs.writeFile(join(dir, "src", "main.rs"), "fn needle() {}\n");
    await fs.writeFile(join(dir, "target", "main.rs"), "fn needle() {}\n");
  });

  it("keeps build output out of grep results", async () => {
    const res = await grepTool.execute({ pattern: "needle" }, ctx());
    expect(res.output).toContain("src/main.rs");
    expect(res.output).not.toContain("target/main.rs");
  });

  it("keeps build output out of glob results", async () => {
    const res = await globTool.execute({ pattern: "**/*.rs" }, ctx());
    expect(res.output).toContain("src/main.rs");
    expect(res.output).not.toContain("target/main.rs");
  });

  it("lets a project un-ignore a directory the fallback would have hidden", async () => {
    // With a .gitignore present, the fallback list does not apply — the
    // project's own statement is the whole answer.
    await fs.writeFile(join(dir, ".gitignore"), "nothing-here/\n");
    const res = await grepTool.execute({ pattern: "needle" }, ctx());
    expect(res.output).toContain("target/main.rs");
  });
});
