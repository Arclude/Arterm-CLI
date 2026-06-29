import { promises as fs } from "node:fs";
import { join } from "node:path";
import { ARTERM_HOME } from "./config.js";
import type { SddSpec } from "./sdd.js";

const SDD_DIR = join(ARTERM_HOME, "sdd");

/** Persists /sdd specs (human `spec.md` + machine `graph.json`) under ARTERM_HOME/sdd. */
export interface SddStore {
  /** Write spec.md + graph.json for a spec; returns the directory path. */
  save(spec: SddSpec): Promise<string>;
  load(id: string): Promise<SddSpec | undefined>;
  list(): Promise<{ id: string; brief: string; createdAt: string }[]>;
}

export function createSddStore(): SddStore {
  return {
    async save(spec) {
      const dir = join(SDD_DIR, spec.id);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(join(dir, "spec.md"), spec.spec, "utf8");
      await fs.writeFile(join(dir, "graph.json"), `${JSON.stringify(spec, null, 2)}\n`, "utf8");
      return dir;
    },
    async load(id) {
      try {
        const raw = await fs.readFile(join(SDD_DIR, id, "graph.json"), "utf8");
        return JSON.parse(raw) as SddSpec;
      } catch {
        return undefined;
      }
    },
    async list() {
      let ids: string[];
      try {
        ids = await fs.readdir(SDD_DIR);
      } catch {
        return [];
      }
      const out: { id: string; brief: string; createdAt: string }[] = [];
      for (const id of ids) {
        try {
          const raw = await fs.readFile(join(SDD_DIR, id, "graph.json"), "utf8");
          const spec = JSON.parse(raw) as SddSpec;
          out.push({ id: spec.id, brief: spec.brief, createdAt: spec.createdAt });
        } catch {
          // Skip unreadable entries.
        }
      }
      return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },
  };
}
