import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { isWithin } from "./paths.js";

/**
 * Where the session's tool calls resolve — the one piece of state whose value
 * changes what every OTHER tool call means.
 *
 * `ToolContext.cwd` is built by the agent, so a tool cannot move it from the
 * inside: the directory lives here, the session owns the store, and the agent
 * reads `current()` when it assembles each context. Same shape as `TodoStore` —
 * state that outlives one tool call belongs outside the tool.
 *
 * **The root never moves, and never comes from a tool call.** `set()` confines
 * every target to the directory the session started in. That is not caution,
 * it is the reason this can exist at all:
 *
 *   - `resolveWithin(ctx.cwd, path)` is what confines every path-taking tool,
 *     and it confines RELATIVE TO `ctx.cwd`. A cwd the model can name is a
 *     confinement boundary the model can name, so `set_working_dir("/")` would
 *     turn `read`, `write` and `edit` into unconfined tools in a single call.
 *     That is CVE-2025-59532 (Codex CLI) and CVE-2026-50548 (Cursor) exactly:
 *     both took the writable root from model output.
 *   - The sandbox's write roots are computed at boot from the session cwd, and
 *     `wrap()` REFUSES a cwd outside them. An unconfined store would therefore
 *     fail in the worst possible direction — `bash` loudly refusing while the
 *     pure-Node file tools quietly widened. Confined to the root, the two
 *     compose: every directory this store can reach is inside `writeRoots[0]`,
 *     which is the same `realpath`'d session cwd.
 *
 * Narrowing is all the model ever needs. The case for the tool is "stop typing
 * `packages/tools/src/` in front of every path", not "reach somewhere new" —
 * and narrowing is free, because `reset()` always leads back.
 */

/** Outcome of a move. `dir` is the directory in force after the call. */
export interface WorkingDirChange {
  ok: boolean;
  /** Where tool calls resolve now — unchanged when `ok` is false. */
  dir: string;
  /** Why the move was refused, when it was. */
  error?: string;
}

/**
 * What the agent needs from the store: one string, read fresh per tool call.
 * Declared structurally because `core` may not depend on `@arterm/tools`, so
 * `AgentOptions` can take this shape without taking this class.
 */
export interface WorkingDirProvider {
  current(): string;
}

export class WorkingDirStore implements WorkingDirProvider {
  /** The boundary: the session's own cwd, `realpath`'d once, at construction. */
  readonly root: string;
  private dir: string;

  constructor(
    root: string,
    private readonly onChange?: (dir: string) => void,
  ) {
    this.root = canonical(root);
    this.dir = this.root;
  }

  current(): string {
    return this.dir;
  }

  /** Where we are relative to the root; "." at the root itself. */
  relative(): string {
    const rel = relative(this.root, this.dir);
    return rel === "" ? "." : rel;
  }

  /**
   * Move to `target`, resolved against the CURRENT directory (so `set("src")`
   * means what a shell's `cd src` means) and confined to the root.
   *
   * Refuses rather than repairs, like `TodoStore.replace`: clamping a target
   * that escaped back to the root would leave the model believing it is
   * somewhere it is not, and every relative path it wrote afterwards would be
   * wrong with no error to read.
   */
  set(target: string): WorkingDirChange {
    const abs = isAbsolute(target) ? resolve(target) : resolve(this.dir, target);
    let real: string;
    try {
      // `realpath` BOTH sides before comparing: a prefix test on unresolved
      // paths is what a symlink sitting inside the root walks straight
      // through, which is the same check `resolveWithin` makes.
      real = realpathSync(abs);
      if (!statSync(real).isDirectory()) {
        return { ok: false, dir: this.dir, error: `Not a directory: ${target}` };
      }
    } catch {
      return { ok: false, dir: this.dir, error: `No such directory: ${target}` };
    }
    if (!isWithin(this.root, real)) {
      return {
        ok: false,
        dir: this.dir,
        error: `Refusing to leave the session root (${this.root}): ${target}`,
      };
    }
    this.dir = real;
    this.onChange?.(this.dir);
    return { ok: true, dir: this.dir };
  }

  /** Back to the root. Always available, which is what makes narrowing safe. */
  reset(): WorkingDirChange {
    this.dir = this.root;
    this.onChange?.(this.dir);
    return { ok: true, dir: this.dir };
  }
}

/** Absolute and symlink-free, falling back to the plain resolve (cf. `sandbox.ts`). */
function canonical(p: string): string {
  const abs = resolve(p);
  try {
    return realpathSync(abs);
  } catch {
    // Not created yet (a worktree about to be cut). The string form is still
    // the right boundary; it just cannot be proven yet.
    return abs;
  }
}
