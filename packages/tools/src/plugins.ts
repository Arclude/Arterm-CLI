import { promises as fs } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { PluginSummary, Tool, TrustTier } from "@arterm/core";

/** Manifest read from a plugin's `plugin.json`. */
export interface PluginManifest {
  name: string;
  description?: string;
  version?: string;
  /** Entry module relative to the plugin dir; defaults to "index.js". */
  main?: string;
}

/** True when `value` looks like an Arterm `Tool` (string name + execute fn). */
function isToolLike(value: unknown): value is Tool {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { name?: unknown; execute?: unknown };
  return typeof candidate.name === "string" && typeof candidate.execute === "function";
}

/** Pulls the exported tools array from a plugin module, in priority order. */
function extractTools(mod: Record<string, unknown>): unknown[] {
  if (Array.isArray(mod.tools)) return mod.tools;
  const def = mod.default as { tools?: unknown } | unknown[] | undefined;
  if (def && typeof def === "object" && !Array.isArray(def) && Array.isArray(def.tools)) {
    return def.tools;
  }
  if (Array.isArray(def)) return def;
  return [];
}

/**
 * Loads local plugins from a directory and applies trust-based capability gating.
 *
 * A plugin is a subdirectory containing a `plugin.json` manifest and a JS entry
 * module that exports an array of Arterm tools. Trust is keyed by manifest name
 * via the `trust` map (default "untrusted"):
 *
 * - trusted   → tools load exactly as declared.
 * - untrusted → tools whose `category === "execute"` are BLOCKED; the rest load
 *   with `permission` forced to "ask" (returned as shallow clones, never mutated).
 *
 * Per-plugin failures are isolated so one bad plugin can't break the others.
 */
export class PluginLoader {
  private _summary: PluginSummary[] = [];

  constructor(
    private readonly dir: string,
    private readonly trust: Record<string, TrustTier> = {},
  ) {}

  get summary(): PluginSummary[] {
    return this._summary;
  }

  /** Discover and load every plugin under `dir`. Never throws. */
  async load(): Promise<Tool[]> {
    let dirents: import("node:fs").Dirent[];
    try {
      dirents = await fs.readdir(this.dir, { withFileTypes: true });
    } catch {
      // Missing plugins dir is not an error — there's simply nothing to load.
      return [];
    }

    const tools: Tool[] = [];
    for (const dirent of dirents) {
      if (!dirent.isDirectory()) continue;
      const subdir = join(this.dir, dirent.name);
      try {
        const manifest = await this.readManifest(subdir);
        const mod = await this.importEntry(subdir, manifest.main ?? "index.js");
        const trust = this.trust[manifest.name] ?? "untrusted";

        let blocked = 0;
        const accepted: Tool[] = [];
        for (const candidate of extractTools(mod)) {
          if (!isToolLike(candidate)) continue;
          if (trust === "untrusted") {
            if (candidate.category === "execute") {
              blocked += 1;
              continue;
            }
            // Force confirmation on every untrusted tool without mutating the original.
            accepted.push({ ...candidate, permission: "ask" });
          } else {
            accepted.push(candidate);
          }
        }

        tools.push(...accepted);
        this._summary.push({
          name: manifest.name,
          status: "loaded",
          toolCount: accepted.length,
          trust,
          blocked,
        });
      } catch (err) {
        this._summary.push({
          name: dirent.name,
          status: "failed",
          toolCount: 0,
          trust: this.trust[dirent.name] ?? "untrusted",
          error: (err as Error).message,
        });
      }
    }
    return tools;
  }

  /** Read and parse `<subdir>/plugin.json`; throws on missing/invalid JSON. */
  private async readManifest(subdir: string): Promise<PluginManifest> {
    const raw = await fs.readFile(join(subdir, "plugin.json"), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) {
      throw new Error("plugin.json is not an object");
    }
    const manifest = parsed as PluginManifest;
    if (typeof manifest.name !== "string" || manifest.name.length === 0) {
      throw new Error('plugin.json is missing a string "name"');
    }
    return manifest;
  }

  /** Dynamic-import the entry module with a Windows-safe file URL. */
  private async importEntry(subdir: string, main: string): Promise<Record<string, unknown>> {
    const url = pathToFileURL(join(subdir, main)).href;
    return (await import(url)) as Record<string, unknown>;
  }
}
