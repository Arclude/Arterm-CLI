import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Tool, TrustTier } from "@arterm/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PluginLoader } from "./plugins.js";

// Scaffold fixtures inside the package dir rather than os.tmpdir(): the loader
// dynamically imports these generated modules, and on Windows CI the OS temp dir
// is an 8.3 short path (…\RUNNER~1\…) outside the project root that the vitest
// module runner can't import. An in-repo, long-form path sidesteps it — the same
// Windows-8.3 tmpdir gotcha that worktree.ts works around by realpath-ing.
const FIXTURE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", ".plugins-fixtures");

let dir: string;

beforeEach(async () => {
  await fs.mkdir(FIXTURE_ROOT, { recursive: true });
  dir = await fs.mkdtemp(join(FIXTURE_ROOT, "case-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

/** A minimal tool source string, embeddable in a generated plugin module. */
function toolSource(name: string, category: "read" | "edit" | "execute"): string {
  return `{ name: ${JSON.stringify(name)}, description: "", parameters: { type: "object", properties: {} }, permission: "allow", category: ${JSON.stringify(category)}, execute: async () => ({ output: "ok" }) }`;
}

/** Scaffold a plugin dir with a manifest and an `index.mjs` exporting `tools`. */
async function scaffold(
  name: string,
  toolDefs: { name: string; category: "read" | "edit" | "execute" }[],
): Promise<void> {
  const sub = join(dir, name);
  await fs.mkdir(sub, { recursive: true });
  await fs.writeFile(join(sub, "plugin.json"), JSON.stringify({ name, main: "index.mjs" }));
  const arr = toolDefs.map((t) => toolSource(t.name, t.category)).join(", ");
  await fs.writeFile(join(sub, "index.mjs"), `export const tools = [${arr}];`);
}

describe("PluginLoader", () => {
  it("loads a trusted plugin's tools unchanged", async () => {
    await scaffold("alpha", [{ name: "runner", category: "execute" }]);
    const trust: Record<string, TrustTier> = { alpha: "trusted" };
    const loader = new PluginLoader(dir, trust);
    const tools = await loader.load();

    expect(tools).toHaveLength(1);
    const tool = tools[0] as Tool;
    expect(tool.name).toBe("runner");
    // Execute-category tool survives with its original "allow" permission.
    expect(tool.category).toBe("execute");
    expect(tool.permission).toBe("allow");

    const summary = loader.summary[0];
    expect(summary?.status).toBe("loaded");
    expect(summary?.trust).toBe("trusted");
    expect(summary?.toolCount).toBe(1);
    expect(summary?.blocked).toBe(0);
  });

  it("gates an untrusted plugin: read forced to ask, execute blocked", async () => {
    await scaffold("beta", [
      { name: "peek", category: "read" },
      { name: "danger", category: "execute" },
    ]);
    const loader = new PluginLoader(dir, { beta: "untrusted" });
    const tools = await loader.load();

    const names = tools.map((t) => t.name);
    expect(names).toContain("peek");
    expect(names).not.toContain("danger");

    const peek = tools.find((t) => t.name === "peek");
    expect(peek?.permission).toBe("ask");

    const summary = loader.summary[0];
    expect(summary?.status).toBe("loaded");
    expect(summary?.trust).toBe("untrusted");
    expect(summary?.toolCount).toBe(1);
    expect(summary?.blocked).toBe(1);
  });

  it("defaults to untrusted when no trust entry is present", async () => {
    await scaffold("gamma", [{ name: "go", category: "execute" }]);
    const loader = new PluginLoader(dir);
    const tools = await loader.load();

    expect(tools).toHaveLength(0);
    expect(loader.summary[0]?.trust).toBe("untrusted");
    expect(loader.summary[0]?.blocked).toBe(1);
  });

  it("records a failure for a missing plugin.json without throwing, and keeps loading others", async () => {
    // A broken plugin: directory exists but no manifest.
    await fs.mkdir(join(dir, "broken"), { recursive: true });
    await fs.writeFile(join(dir, "broken", "index.mjs"), "export const tools = [];");
    // A good plugin alongside it.
    await scaffold("good", [{ name: "peek", category: "read" }]);

    const loader = new PluginLoader(dir, { good: "trusted" });
    const tools = await loader.load();

    expect(tools.map((t) => t.name)).toContain("peek");
    const failed = loader.summary.find((s) => s.name === "broken");
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toBeTruthy();
    expect(loader.summary.find((s) => s.name === "good")?.status).toBe("loaded");
  });

  it("records a failure for invalid JSON in plugin.json", async () => {
    const sub = join(dir, "badjson");
    await fs.mkdir(sub, { recursive: true });
    await fs.writeFile(join(sub, "plugin.json"), "{ not valid json");
    await fs.writeFile(join(sub, "index.mjs"), "export const tools = [];");

    const loader = new PluginLoader(dir);
    await expect(loader.load()).resolves.toEqual([]);
    expect(loader.summary[0]?.status).toBe("failed");
  });

  it("returns [] when the plugins dir is missing", async () => {
    const loader = new PluginLoader(join(dir, "does-not-exist"));
    await expect(loader.load()).resolves.toEqual([]);
    expect(loader.summary).toEqual([]);
  });

  it("does not mutate the original tool object when gating", async () => {
    const sub = join(dir, "delta");
    await fs.mkdir(sub, { recursive: true });
    await fs.writeFile(
      join(sub, "plugin.json"),
      JSON.stringify({ name: "delta", main: "index.mjs" }),
    );
    // Capture the original tool's permission and re-export it for inspection.
    await fs.writeFile(
      join(sub, "index.mjs"),
      `export const original = { name: "peek", description: "", parameters: { type: "object", properties: {} }, permission: "allow", category: "read", execute: async () => ({ output: "ok" }) };\nexport const tools = [original];`,
    );

    const loader = new PluginLoader(dir, { delta: "untrusted" });
    const tools = await loader.load();
    expect(tools[0]?.permission).toBe("ask");

    // The source module's original object must keep its declared permission.
    const mod = (await import(pathToFileURL(join(sub, "index.mjs")).href)) as {
      original: Tool;
    };
    expect(mod.original.permission).toBe("allow");
  });

  it("does not duplicate summary entries across repeated loads", async () => {
    await scaffold("alpha", [{ name: "peek", category: "read" }]);
    const loader = new PluginLoader(dir);
    await loader.load();
    await loader.load();
    expect(loader.summary).toHaveLength(1);
  });

  it("reload picks up a newly added plugin and keeps the summary array identity", async () => {
    await scaffold("alpha", [{ name: "peek", category: "read" }]);
    const loader = new PluginLoader(dir);
    await loader.load();
    const ref = loader.summary;

    await scaffold("beta", [{ name: "poke", category: "read" }]);
    const tools = await loader.reload();
    expect(tools.map((t) => t.name).sort()).toEqual(["peek", "poke"]);
    expect(loader.summary).toBe(ref);
    expect(loader.summary.map((s) => s.name).sort()).toEqual(["alpha", "beta"]);
  });

  it("reload recovers a plugin fixed on disk after a failed import", async () => {
    const sub = join(dir, "fixme");
    await fs.mkdir(sub, { recursive: true });
    await fs.writeFile(
      join(sub, "plugin.json"),
      JSON.stringify({ name: "fixme", main: "index.mjs" }),
    );
    await fs.writeFile(join(sub, "index.mjs"), "export const tools = ["); // syntax error
    const loader = new PluginLoader(dir, { fixme: "trusted" });
    await loader.load();
    expect(loader.summary[0]?.status).toBe("failed");

    await fs.writeFile(
      join(sub, "index.mjs"),
      `export const tools = [${toolSource("fixed", "read")}];`,
    );
    const tools = await loader.reload();
    expect(tools.map((t) => t.name)).toEqual(["fixed"]);
    expect(loader.summary[0]?.status).toBe("loaded");
  });
});

describe("PluginLoader.check", () => {
  it("reports healthy plugins with their loaded tool count", async () => {
    await scaffold("alpha", [{ name: "peek", category: "read" }]);
    const loader = new PluginLoader(dir, { alpha: "trusted" });
    await loader.load();
    const results = await loader.check();
    expect(results).toEqual([{ name: "alpha", ok: true, toolCount: 1 }]);
  });

  it("flags a missing manifest and a missing entry module", async () => {
    await fs.mkdir(join(dir, "nomanifest"), { recursive: true });
    const sub = join(dir, "noentry");
    await fs.mkdir(sub, { recursive: true });
    await fs.writeFile(
      join(sub, "plugin.json"),
      JSON.stringify({ name: "noentry", main: "gone.mjs" }),
    );

    const loader = new PluginLoader(dir);
    const results = await loader.check();
    expect(results.find((r) => r.name === "nomanifest")?.ok).toBe(false);
    expect(results.find((r) => r.name === "noentry")?.ok).toBe(false);
  });

  it("flags a loaded plugin whose directory has vanished, without touching the summary", async () => {
    await scaffold("alpha", [{ name: "peek", category: "read" }]);
    const loader = new PluginLoader(dir);
    await loader.load();
    await fs.rm(join(dir, "alpha"), { recursive: true, force: true });

    const results = await loader.check();
    expect(results).toEqual([
      { name: "alpha", ok: false, error: "plugin directory no longer exists" },
    ]);
    expect(loader.summary[0]?.status).toBe("loaded"); // check is side-effect-free
  });

  it("returns [] when the plugins dir is missing and nothing was loaded", async () => {
    const loader = new PluginLoader(join(dir, "nope"));
    await expect(loader.check()).resolves.toEqual([]);
  });
});
