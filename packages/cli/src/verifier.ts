import {
  type ArtermConfig,
  type ChatProvider,
  type Chronicle,
  type ContextStrategy,
  type JudgeRun,
  PermissionManager,
  type Tool,
  type VerdictCapture,
  type Verifier,
  type VerifyLedger,
  captureVerdict,
  makeCommandVerifier,
  makeCompositeVerifier,
  makeJudgeVerifier,
  runSubagent,
  verifyEvidenceLine,
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
  /**
   * The run's ledger. Supplied, not required: a verifier built without one is
   * exactly what it was before — the judge reading the result and nothing else.
   */
  chronicle?: Chronicle;
  /**
   * Whether the tree has been verified since it was last edited. Optional for
   * the same reason the chronicle is: absent, the judge simply reads one fewer
   * fact, which is what it did before either existed.
   */
  verifyLedger?: VerifyLedger;
}

/** How many files the evidence block names before it starts counting instead. */
const MAX_EVIDENCE_FILES = 40;

/**
 * The ledger as a block the judge can read against the claim.
 *
 * Returns undefined when the run recorded no writes at all — an empty section
 * headed "what was recorded" invites the reading that nothing happened, when
 * the truthful statement is that this ledger covers file writes and a run can
 * legitimately have none (a review, a question, a build).
 *
 * Truncation is stated rather than silent, the same rule `roundClaim` follows:
 * a list that quietly stops at 40 reads as a complete account of 40 files.
 */
export function evidenceBlock(
  chronicle: Chronicle | undefined,
  ledger?: VerifyLedger,
): string | undefined {
  // The verification line stands on its own. A run that edited nothing can
  // still have run the tests, and a run that edited plenty and never ran them
  // is exactly the case worth printing — so this is not gated on there being
  // file changes to list.
  const verified = ledger ? verifyEvidenceLine(ledger.state()) : undefined;
  if (!chronicle) return verified;
  const files = chronicle.changed();
  if (files.length === 0) return verified;
  const shown = files.slice(0, MAX_EVIDENCE_FILES);
  const lines = shown.map((f) => {
    const who = f.by.length > 0 ? ` by ${f.by.join(", ")}` : "";
    // "gone" rather than an omitted column: a file written and then deleted is
    // a different fact from one the ledger has no digest for.
    const digest = f.contentHashAfter ? f.contentHashAfter.slice(0, 12) : "gone";
    const writes = f.writes > 1 ? ` (${f.writes} writes)` : "";
    return `- ${f.path}  +${f.added}/-${f.removed}  ${digest}${writes}${who}`;
  });
  if (files.length > shown.length) {
    lines.push(`- …and ${files.length - shown.length} more file(s) not listed`);
  }
  const denied = chronicle.deniedCount();
  if (denied > 0) {
    lines.push(`- ${denied} tool call(s) were DENIED by the permission policy and never ran`);
  }
  if (verified) lines.push(verified);
  return lines.join("\n");
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
  const composite = makeCompositeVerifier(parts);
  // Decorated here rather than inside the composite: the ledger is a fact about
  // THIS session, and `core` has no way to reach it. The command gate ignores
  // the field; only `buildJudgeInstruction` renders it.
  return async (req) => {
    const evidence = evidenceBlock(deps.chronicle, deps.verifyLedger);
    return composite(evidence ? { ...req, evidence } : req);
  };
}
