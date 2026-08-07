import {
  type ArtermConfig,
  type ChatProvider,
  type ContextStrategy,
  type JudgeRun,
  PermissionManager,
  type Tool,
  type VerdictCapture,
  type Verifier,
  captureVerdict,
  makeCommandVerifier,
  makeCompositeVerifier,
  makeJudgeVerifier,
  runSubagent,
} from "@arterm/core";
import { submitVerdictTool } from "@arterm/tools";

/**
 * Builds the session's result verifier: a deterministic command gate, with a
 * fresh-context LLM judge behind it.
 *
 * Lives outside `session.ts` so the judge runner can be unit-tested with a stub
 * provider — the thing that used to make this untestable is exactly where the bug
 * was.
 *
 * The division of labour is deliberate: **the gate runs, the judge reads.** The
 * judge gets read-only tools in plan mode with a denying asker, so it cannot run
 * the verification command (or anything else); the command gate runs it in-process.
 */
export interface VerifierDeps {
  /**
   * Getters, not values — `/model` and `/login` swap the provider mid-session, and
   * a captured snapshot would keep judging with the old one.
   */
  provider: () => ChatProvider;
  model: () => string;
  tools: () => Tool[];
  context: () => ContextStrategy | undefined;
  cwd: string;
  config: ArtermConfig;
}

/** Whether verification is on, honoring the superseded `autonomy.verify` flag. */
export function verifyEnabled(config: ArtermConfig): boolean {
  return config.verify?.enabled ?? config.autonomy?.verify ?? true;
}

/**
 * One isolated judge turn. Returns what the judge delivered — never throws, and
 * never reports a verdict it did not get.
 *
 * The verdict is read off the sub-agent's private bus rather than out of its
 * return string. That is the fix for the old check (`/^\s*PASS\b/i` on the
 * output): `runSubagent` returns `"sub-agent failed: 401 …"` instead of throwing,
 * so a dead API key read as an explicit rejection and stopped the run after two
 * of them — blaming the worker for an auth failure.
 */
export function createJudgeRun(deps: VerifierDeps): JudgeRun {
  return async (prompt, signal) => {
    const capture = captureVerdict();
    try {
      await runSubagent(
        prompt,
        {
          provider: deps.provider(),
          model: deps.config.verify?.model ?? deps.config.autonomy?.verifyModel ?? deps.model(),
          // Read-only + plan mode + a denying asker: the judge inspects, never acts.
          tools: deps.tools().filter((t) => t.category === "read"),
          permissions: new PermissionManager({}, "plan"),
          ask: async () => "deny",
          cwd: deps.cwd,
          // The verdict tool IS the review's terminal signal: one call both
          // records the answer and ends the run, so a weak model has no
          // "decide, then finish" two-step to half-perform.
          taskDone: submitVerdictTool,
          context: deps.context(),
          maxSteps: deps.config.verify?.maxSteps ?? 2,
          maxIterations: deps.config.verify?.maxIterations ?? 10,
          role: "verifier",
          onEvent: capture.onEvent,
        },
        signal,
      );
    } catch {
      // Fail open: an empty capture is indistinguishable from "the judge said
      // nothing", which is exactly how it should be treated.
    }
    return capture.result() satisfies VerdictCapture;
  };
}

/**
 * The session's verifier, or `undefined` when verification is off — in which case
 * nothing downstream pays for it.
 */
export function createVerifier(deps: VerifierDeps): Verifier | undefined {
  if (!verifyEnabled(deps.config)) return undefined;

  const parts: Verifier[] = [
    makeCommandVerifier({
      cwd: deps.cwd,
      ...(deps.config.verify?.commandTimeoutMs !== undefined
        ? { timeoutMs: deps.config.verify.commandTimeoutMs }
        : {}),
      // The standing gate: what runs when the work declares no `verify:` line of
      // its own. Without it an undeclared unit is judged by a reviewer that only
      // reads, so nothing ever executes the suite.
      ...(deps.config.verify?.command ? { defaultCommand: deps.config.verify.command } : {}),
      ...(deps.config.credentials ? { credentials: deps.config.credentials } : {}),
    }),
  ];
  // The judge is separately switchable: on a small local model it can be noise,
  // and without this flag the only escape hatch would throw out the free
  // deterministic gate along with it.
  if (deps.config.verify?.judge !== false) {
    parts.push(makeJudgeVerifier({ run: createJudgeRun(deps) }));
  }
  return makeCompositeVerifier(parts);
}
