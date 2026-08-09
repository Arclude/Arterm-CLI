import type { Middleware, ToolCallCtx } from "./kernel/pipeline.js";

/**
 * Has this workspace been verified SINCE the last edit?
 *
 * The chronicle answers "what changed"; the judge is handed that and asked to
 * read it against the claim. Neither answers this one, and it is the question a
 * reviewer actually asks first. A run that ran the tests at step 5, edited nine
 * files at step 20 and then claimed completion has a passing test result and a
 * worthless one, and nothing in the record could previously tell those apart —
 * a timestamp is not evidence unless something knows what happened after it.
 *
 * So this is a ledger of what was CHECKED, and its whole point is that entries
 * EXPIRE. `markEdited` is what makes it evidence rather than a log.
 *
 * Deliberately pure and deliberately passive. It observes tool calls that have
 * already happened; it never runs a command, never blocks one, and never
 * decides an outcome. `verify.ts` owns the gate, and this only gives the judge
 * one more fact to read — which keeps the asymmetry that file states: the
 * command may block, the judge fails open, and a ledger is neither.
 */

/** What the ledger can say about the working tree right now. */
export type VerifyStatus =
  /** Nothing recognizable as a verification command has run. */
  | "none"
  /** A verification command passed, and nothing has been edited since. */
  | "passed"
  /** A verification command passed, but the tree was edited afterwards. */
  | "stale"
  /** The last verification command failed, and has not been re-run. */
  | "failed";

export interface VerifyRecord {
  status: VerifyStatus;
  /** The command as the ledger normalized it, for reporting. */
  command?: string;
  /**
   * `full` when the command was run over the whole project, `targeted` when it
   * carried a path. A targeted pass says less: it is evidence about one file,
   * not about the tree, and a reader told only "passed" would over-read it.
   */
  scope?: "full" | "targeted";
  /** Paths edited since the last verification, for the stale explanation. */
  editedSince: string[];
}

/**
 * Runners whose invocation is a verification claim.
 *
 * A recognizer, not an allowlist: anything unrecognized simply is not evidence,
 * and the ledger says `none` rather than guessing. The failure mode of guessing
 * wide is worse than the failure mode of guessing narrow — a false "verified"
 * is a claim the judge will believe.
 */
const VERIFY_VERBS = ["test", "lint", "typecheck", "check", "build"];

/** Package runners whose `run <verb>` and bare `<verb>` forms mean the same. */
const NODE_RUNNERS = ["pnpm", "npm", "yarn", "bun"];

/**
 * Normalize a command to its canonical form, or `null` when it is not a
 * verification command.
 *
 * Equivalence matters because the ledger is keyed on what the human or the
 * model happened to type. `npm run test` and `npm test` are one command; so are
 * `pytest`, `python -m pytest` and `uv run pytest`. Treating them as different
 * would leave a tree verified by one of them looking unverified to a check
 * written against the other — the ledger would be correct about its own
 * bookkeeping and wrong about the world.
 */
export function normalizeVerifyCommand(raw: string): string | null {
  const cmd = raw.trim().replace(/\s+/g, " ");
  if (!cmd) return null;
  // Only the first statement is considered. A compound line is a script, and
  // what its later parts did is not something this can claim to know.
  const head = cmd.split(/&&|\|\||;|\|/)[0]?.trim() ?? "";
  const parts = head.split(" ").filter(Boolean);
  if (parts.length === 0) return null;

  let [bin, ...rest] = parts as [string, ...string[]];
  // `uv run X`, `poetry run X`, `npx X` — the wrapper is not the command.
  while (
    rest.length > 0 &&
    ((["uv", "poetry", "pdm", "rye"].includes(bin) && rest[0] === "run") || bin === "npx")
  ) {
    rest = bin === "npx" ? rest : rest.slice(1);
    const next = rest.shift();
    if (!next) return null;
    bin = next;
  }

  if (NODE_RUNNERS.includes(bin)) {
    const args = rest[0] === "run" ? rest.slice(1) : rest;
    const verb = args[0];
    // `-r`/`--filter` sit before the verb in a workspace invocation.
    const verbAt = args.findIndex(
      (a) => !a.startsWith("-") && a !== "--filter" && !isFlagValue(args, a),
    );
    const resolved = verb && VERIFY_VERBS.includes(verb) ? verb : args[verbAt >= 0 ? verbAt : 0];
    if (!resolved || !VERIFY_VERBS.includes(resolved)) return null;
    return `${bin} ${resolved}`;
  }

  if (bin === "python" || bin === "python3") {
    if (rest[0] === "-m" && rest[1])
      return normalizeVerifyCommand([rest[1], ...rest.slice(2)].join(" "));
    return null;
  }

  if (bin === "pytest") return "pytest";
  if ((bin === "cargo" || bin === "go") && rest[0] && VERIFY_VERBS.includes(rest[0])) {
    return `${bin} ${rest[0]}`;
  }
  if (bin === "make" && rest[0] && VERIFY_VERBS.includes(rest[0])) return `make ${rest[0]}`;
  if (bin === "tsc") return "tsc";
  return null;
}

/** True when `a` looks like the value of a preceding flag rather than a verb. */
function isFlagValue(args: string[], a: string): boolean {
  const i = args.indexOf(a);
  return i > 0 && args[i - 1] === "--filter";
}

/**
 * Paths whose change cannot invalidate a test run.
 *
 * Without this the ledger nags after a README edit, and a check that fires when
 * it should not is one people learn to ignore — which costs the times it was
 * right. Matched on the path, never on the diff: a prose file is prose whatever
 * it contains.
 */
const DOC_PATTERN = /(^|\/)(docs?|\.github)\//i;
const DOC_EXTENSIONS = [".md", ".mdx", ".txt", ".rst", ".adoc"];

export function isDocPath(path: string): boolean {
  const lower = path.toLowerCase();
  return DOC_PATTERN.test(lower) || DOC_EXTENSIONS.some((e) => lower.endsWith(e));
}

/**
 * The ledger. One per run, shared with sub-agents for the same reason the
 * chronicle is: the workers are where the editing happens, and a ledger that
 * saw only the leader would describe the one agent that mostly reads.
 */
export class VerifyLedger {
  private status: VerifyStatus = "none";
  private command: string | undefined;
  private scope: "full" | "targeted" | undefined;
  private edited: string[] = [];

  /**
   * Record that a command ran to completion.
   *
   * A non-verification command is not an event here — it is not evidence and
   * not an edit, so it leaves the ledger exactly as it was.
   */
  observeCommand(raw: string, exitCode: number): void {
    const normalized = normalizeVerifyCommand(raw);
    if (!normalized) return;
    this.command = normalized;
    // A path argument narrows what the result can be said to cover.
    this.scope = /(^|\s)[\w./-]*\/[\w./-]+/.test(raw.replace(normalized, "")) ? "targeted" : "full";
    this.status = exitCode === 0 ? "passed" : "failed";
    this.edited = [];
  }

  /**
   * Record that files landed on disk.
   *
   * Only a PASS goes stale. A failure that is followed by edits is still a
   * failure — the edits are presumably the fix, and calling it "stale" would
   * quietly retire the one status a reader should act on.
   */
  markEdited(paths: readonly string[]): void {
    const relevant = paths.filter((p) => !isDocPath(p));
    if (relevant.length === 0) return;
    for (const p of relevant) if (!this.edited.includes(p)) this.edited.push(p);
    if (this.status === "passed") this.status = "stale";
  }

  state(): VerifyRecord {
    return {
      status: this.status,
      ...(this.command ? { command: this.command } : {}),
      ...(this.scope ? { scope: this.scope } : {}),
      editedSince: [...this.edited],
    };
  }
}

/** How many edited paths a stale line names before it summarizes. */
const MAX_STALE_PATHS = 5;

/**
 * One line for the judge's evidence block, or nothing when there is nothing to
 * say.
 *
 * `none` returns undefined rather than "not verified": on a run with no test
 * suite — a review, a question, a docs change — that sentence is an accusation
 * about the absence of something that was never expected. The statuses that DO
 * print are the ones a reader can act on.
 */
export function verifyEvidenceLine(record: VerifyRecord): string | undefined {
  const scope = record.scope === "targeted" ? " (targeted, not the whole project)" : "";
  switch (record.status) {
    case "passed":
      return `- \`${record.command}\` passed after the last edit${scope}`;
    case "failed":
      return `- \`${record.command}\` FAILED and has not been re-run since${scope}`;
    case "stale": {
      const shown = record.editedSince.slice(0, MAX_STALE_PATHS);
      const more =
        record.editedSince.length > shown.length
          ? ` and ${record.editedSince.length - shown.length} more`
          : "";
      return `- \`${record.command}\` passed, but ${shown.join(", ")}${more} changed AFTERWARDS — that result does not cover the current tree`;
    }
    default:
      return undefined;
  }
}

/**
 * The `toolCall` stage that feeds the ledger.
 *
 * Registered AFTER `execute`, unlike the chronicle's — which sits at
 * `before("permission")` so a denial still lands in the record. A denial is not
 * an event here: a command that never ran verified nothing and edited nothing,
 * and the ledger only has something to say once a call has an outcome.
 *
 * The exit code is read as `isError`, which is the signal every tool actually
 * agrees on. Parsing a number back out of the output would be reading the
 * shell's prose to learn something the result already states.
 */
export function verifyLedgerToolCall(ledger: VerifyLedger): Middleware<ToolCallCtx> {
  return async (ctx, next) => {
    await next();
    if (ctx.tool === undefined) return; // denied or unknown — nothing happened
    // A mutation reports the path it wrote; the same declaration the chronicle
    // relies on, so a tool that is invisible to one is invisible to both.
    if (ctx.path) ledger.markEdited([ctx.path]);
    const command = commandOf(ctx.call.name, ctx.call.arguments);
    if (command) ledger.observeCommand(command, ctx.isError ? 1 : 0);
  };
}

/**
 * The command a call is about to run, for the tools that run one.
 *
 * Named explicitly rather than sniffed from any `command`-ish argument: a tool
 * that merely CARRIES a command string (a todo entry describing one, a skill
 * quoting one) must not be read as having executed it.
 */
function commandOf(tool: string, args: Record<string, unknown>): string | undefined {
  if (tool === "bash") {
    return typeof args.command === "string" ? args.command : undefined;
  }
  if (tool === "exec") {
    const bin = args.command;
    if (typeof bin !== "string") return undefined;
    const rest = Array.isArray(args.args) ? args.args.filter((a) => typeof a === "string") : [];
    return [bin, ...rest].join(" ");
  }
  return undefined;
}
