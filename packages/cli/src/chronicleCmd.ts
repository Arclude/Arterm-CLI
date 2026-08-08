/**
 * `arterm chronicle` — read the ledger back, and check that nothing edited it.
 *
 * Two questions, deliberately separate. `verify` asks whether the chain is
 * intact; `show` asks what a run did. Answering the second without the first is
 * how a doctored record gets quoted as evidence, so `show` states the chain's
 * status on its own last line rather than leaving the reader to go and ask.
 */

import { type ChronicleRecord, verifyChain } from "@arterm/core";
import { listChronicles, readChronicle } from "./chronicleStore.js";

/** Newest session with a ledger, so the common case needs no id. */
function latestSession(): string | undefined {
  return listChronicles()[0]?.sessionId;
}

function resolveSession(sessionId?: string): string | undefined {
  return sessionId ?? latestSession();
}

const OUTCOME_GLYPH: Record<string, string> = {
  success: "✓",
  failure: "✗",
  denied: "⊘",
};

/** One record as a line: what ran, what it touched, what came of it. */
function line(record: ChronicleRecord): string {
  const glyph = OUTCOME_GLYPH[record.outcome] ?? "·";
  const head = `${glyph} ${String(record.sequence).padStart(3)}  ${record.toolName ?? "—"}`;
  if (!record.change) return head;
  const { path, added, removed, contentHashAfter } = record.change;
  // The hash is the part that is not the tool's word for it, so it is shown
  // even truncated: a reader comparing two runs needs something to compare.
  const digest = contentHashAfter ? contentHashAfter.slice(0, 12) : "gone";
  return `${head}  ${path}  +${added}/-${removed}  ${digest}`;
}

export function runChronicleVerify(sessionId: string | undefined, json: boolean): void {
  const session = resolveSession(sessionId);
  if (!session) {
    process.stdout.write(
      json ? '{"error":"no chronicle found"}\n' : "No chronicle recorded yet.\n",
    );
    process.exitCode = 1;
    return;
  }
  const { records, unreadable, file } = readChronicle(session);
  const result = verifyChain(records);
  if (json) {
    process.stdout.write(`${JSON.stringify({ session, file, unreadable, ...result })}\n`);
  } else if (result.ok) {
    process.stdout.write(
      `✓ chain intact — ${result.entries} record(s), head ${result.lastHash.slice(0, 12)}…\n` +
        `  ${file}\n` +
        (unreadable > 0 ? `  ⚠ ${unreadable} unreadable line(s) skipped\n` : ""),
    );
  } else {
    process.stdout.write(`✗ chain broken at record ${result.brokenAt}\n  ${result.reason}\n`);
  }
  // A broken chain is a failed check, not a report: scripts gate on this.
  if (!result.ok) process.exitCode = 1;
}

export function runChronicleShow(sessionId: string | undefined, json: boolean): void {
  const session = resolveSession(sessionId);
  if (!session) {
    process.stdout.write(
      json ? '{"error":"no chronicle found"}\n' : "No chronicle recorded yet.\n",
    );
    process.exitCode = 1;
    return;
  }
  const { records, unreadable, file } = readChronicle(session);
  const result = verifyChain(records);
  if (json) {
    process.stdout.write(`${JSON.stringify({ session, file, unreadable, result, records })}\n`);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  const changed = records.filter((r) => r.change);
  process.stdout.write(
    `${session}  ${records.length} record(s), ${changed.length} file change(s)\n\n` +
      `${records.map(line).join("\n")}\n\n` +
      (result.ok
        ? `✓ chain intact (head ${result.lastHash.slice(0, 12)}…)\n`
        : `✗ chain broken at ${result.brokenAt}: ${result.reason}\n`) +
      (unreadable > 0 ? `⚠ ${unreadable} unreadable line(s) skipped\n` : ""),
  );
  if (!result.ok) process.exitCode = 1;
}

export function runChronicleList(json: boolean): void {
  const rows = listChronicles();
  if (json) {
    process.stdout.write(`${JSON.stringify(rows)}\n`);
    return;
  }
  if (rows.length === 0) {
    process.stdout.write("No chronicle recorded yet.\n");
    return;
  }
  for (const row of rows) {
    process.stdout.write(`${new Date(row.at).toISOString()}  ${row.sessionId}\n`);
  }
}
