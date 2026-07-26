import { type Tool, VERDICT_TOOL_NAME, formatVerdictEcho } from "@arterm/core";

/**
 * The channel a reviewer delivers its verdict on.
 *
 * Passed as the judge sub-agent's `taskDone`, so one call both records the verdict
 * and ends the review — a weak model has no two-step ("decide, then finish") to
 * half-perform, and no steps are burned after the answer.
 *
 * `permission: "allow"` and `category: "read"` are both load-bearing, not defaults:
 * the judge runs with `ask: () => "deny"`, so an `"ask"` tool would deny its own
 * verdict, and plan mode blocks every tool whose category is not `"read"` — which
 * this genuinely is, since the tool mutates nothing.
 *
 * `mustFix` is deliberately NOT required. A required field a small model omits
 * becomes a hard parse failure, and under fail-open a parse failure would upgrade
 * a rejection into an acceptance. `normalizeVerdict` enforces it asymmetrically
 * instead: a rejection with nothing named still blocks.
 */
export const submitVerdictTool: Tool = {
  name: VERDICT_TOOL_NAME,
  description:
    "Deliver your review verdict. Call this exactly once, as your final action. A reply that " +
    "does not call this tool is discarded and the work is accepted unreviewed.",
  permission: "allow",
  category: "read",
  parameters: {
    type: "object",
    properties: {
      pass: {
        type: "boolean",
        description: "true = acceptable as-is. false = must be fixed before it can be accepted.",
      },
      summary: {
        type: "string",
        description: "One or two sentences: what you concluded, and why.",
      },
      mustFix: {
        type: "array",
        items: { type: "string" },
        description:
          "One entry per problem — name the file and what to change. Required in substance " +
          "whenever pass is false.",
      },
      refs: {
        type: "array",
        items: { type: "string" },
        description: "What you actually inspected: files read, commands run, tests executed.",
      },
    },
    required: ["pass", "summary"],
  },
  preview: (args) => `submit verdict: ${args.pass === true ? "PASS" : "FAIL"}`,
  async execute(args) {
    // The verdict does not escape through this return value — the caller reads it
    // off the bus, upstream of the permission chain, so it cannot be lost to a
    // denial or a short-circuiting middleware. This is only the confirmation the
    // model sees. Because the tool also terminates the review, a malformed payload
    // ends the run before the corrective message below can be acted on; that is
    // accepted, and it fails open by design.
    return formatVerdictEcho(args);
  },
};
