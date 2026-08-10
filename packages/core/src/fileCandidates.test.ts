import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ALWAYS_SKIPPED, listCandidates } from "./fileCandidates.js";

const run = promisify(execFile);

describe("listCandidates", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "arterm-candidates-")));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  describe("in a repository", () => {
    beforeEach(async () => {
      await run("git", ["init", "-q"], { cwd: dir });
      await fs.writeFile(join(dir, ".gitignore"), "secret.txt\n");
      await fs.writeFile(join(dir, "tracked.ts"), "x");
      await run("git", ["add", "tracked.ts"], { cwd: dir });
    });

    it("offers a file that is tracked", async () => {
      expect(await listCandidates(dir)).toContain("tracked.ts");
    });

    it("offers a file created ten seconds ago and never committed", async () => {
      // Listing only tracked files would leave a brand-new file uncompletable
      // until it was committed — which is exactly when someone wants to point
      // the model at it.
      await fs.writeFile(join(dir, "brand-new.ts"), "x");
      expect(await listCandidates(dir)).toContain("brand-new.ts");
    });

    it("does not offer an ignored file", async () => {
      // The scope limit is stated rather than hidden: it can still be TYPED, and
      // `readMentions` reads it exactly the same way.
      await fs.writeFile(join(dir, "secret.txt"), "x");
      expect(await listCandidates(dir)).not.toContain("secret.txt");
    });
  });

  describe("outside a repository", () => {
    it("walks the tree rather than offering nothing", async () => {
      // A terminal agent is used plenty of places that are not repositories, and
      // an empty picker there reads as broken rather than as scoped.
      await fs.writeFile(join(dir, "notes.md"), "x");
      await fs.mkdir(join(dir, "sub"));
      await fs.writeFile(join(dir, "sub", "deep.txt"), "x");
      const files = await listCandidates(dir);
      expect(files).toContain("notes.md");
      expect(files).toContain("sub/deep.txt");
    });

    it("skips the directories nobody wants in a file list", async () => {
      await fs.mkdir(join(dir, "node_modules", "pkg"), { recursive: true });
      await fs.writeFile(join(dir, "node_modules", "pkg", "index.js"), "x");
      const files = await listCandidates(dir);
      expect(files.some((f) => f.startsWith("node_modules/"))).toBe(false);
      expect(ALWAYS_SKIPPED.has("node_modules")).toBe(true);
    });

    it("returns an empty list rather than throwing on a directory it cannot read", async () => {
      // A picker whose list failed to build shows nothing, which is what it also
      // shows in an empty directory — neither is a reason to interrupt typing.
      await expect(listCandidates(join(dir, "does-not-exist"))).resolves.toEqual([]);
    });
  });
});
