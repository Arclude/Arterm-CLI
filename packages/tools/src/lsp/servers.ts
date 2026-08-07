/**
 * Which language server answers for which file, and whether it is here.
 *
 * A hard dependency was never an option: these are hundreds of megabytes
 * between them, they are per-language, and most sessions need none. The pattern
 * is the one `providers` uses for `node-llama-cpp` — look for it, and when it
 * is absent say what to install rather than failing obscurely.
 *
 * Two places are searched, in order. The project's own `node_modules/.bin`
 * comes FIRST: a repository that lists `typescript-language-server` as a dev
 * dependency has pinned a version deliberately, and preferring whatever happens
 * to be on the developer's PATH would answer with a different compiler than the
 * project's own.
 */

import { constants, access } from "node:fs/promises";
import { delimiter, resolve } from "node:path";
import type { CallLang } from "../treeSitter.js";

export interface ServerSpec {
  /** Binary name, looked up on PATH and in the project's node_modules/.bin. */
  command: string;
  args: string[];
  /** What to tell someone who does not have it. */
  install: string;
  /** Extensions this server is asked about. */
  languageId: string;
}

/** The `languageId` LSP expects, per grammar. */
const LANGUAGE_ID: Record<CallLang, string> = {
  typescript: "typescript",
  tsx: "typescriptreact",
  javascript: "javascript",
  python: "python",
};

const SERVERS: Record<CallLang, ServerSpec[]> = {
  typescript: [tsServer("typescript")],
  tsx: [tsServer("typescriptreact")],
  javascript: [tsServer("javascript")],
  python: [
    {
      command: "pyright-langserver",
      args: ["--stdio"],
      install: "npm i -g pyright",
      languageId: "python",
    },
    { command: "pylsp", args: [], install: "pip install python-lsp-server", languageId: "python" },
  ],
};

function tsServer(languageId: string): ServerSpec {
  return {
    command: "typescript-language-server",
    args: ["--stdio"],
    install: "npm i -g typescript-language-server typescript",
    languageId,
  };
}

/** The language id to announce for a file, given its grammar. */
export function languageIdFor(lang: CallLang): string {
  return LANGUAGE_ID[lang];
}

async function executable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve a binary name to an ABSOLUTE path, preferring the project's own copy.
 *
 * Absolute is not a nicety. A PATH entry may be relative — pnpm puts a bare
 * `node_modules/.bin` on it — and the server is spawned with `cwd` set to the
 * project root, which is not the directory that relative entry meant. The
 * lookup then succeeds and the spawn fails, with the only symptom being a
 * server that closes its output immediately.
 */
export async function resolveServerBinary(
  command: string,
  root: string,
): Promise<string | undefined> {
  const local = resolve(root, "node_modules", ".bin", command);
  if (await executable(local)) return local;
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = resolve(dir, command);
    if (await executable(candidate)) return candidate;
  }
  return undefined;
}

export interface ResolvedServer {
  spec: ServerSpec;
  binary: string;
}

/** The first available server for a language, or the list of what would work. */
export async function serverFor(
  lang: CallLang,
  root: string,
): Promise<{ server: ResolvedServer } | { missing: ServerSpec[] }> {
  const candidates = SERVERS[lang];
  for (const spec of candidates) {
    const binary = await resolveServerBinary(spec.command, root);
    if (binary) return { server: { spec, binary } };
  }
  return { missing: candidates };
}

/** The sentence a tool prints when no server is installed. */
export function installHint(missing: ServerSpec[]): string {
  const options = missing.map((s) => `${s.command} (${s.install})`).join(", or ");
  const fallback =
    "Until then `callers`, `symbols` and `typecheck` answer weaker versions of the same questions.";
  return `No language server found for this file. Install one and it will be picked up: ${options}. ${fallback}`;
}
