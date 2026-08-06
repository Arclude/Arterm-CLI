"""Check the contract between `arterm --print --json` and the Harbor adapter.

The adapter reads a JSON document our CLI writes. Nothing in either language's
type system spans that seam, so a rename on the TypeScript side would show up
only as a benchmark run that silently reported zero tokens and no cost — a
number that looks fine and is wrong. This asserts the seam directly.

    python bench/harbor/selfcheck.py [path/to/arterm-result.json]

With no argument it uses the checked-in sample. To check against a live run:

    node scripts/fault-server.mjs --mode ok --tool task_done --port 8151 &
    arterm --print --json --goal "say hi" --autonomous --no-sandbox --max-steps 2 \
      > /tmp/r.json
    python bench/harbor/selfcheck.py /tmp/r.json
"""

from __future__ import annotations

import json
import shutil
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from bench.harbor.arterm_agent import HARNESS_NAME, RESULT_NAME, ArtermAgent  # noqa: E402
from harbor.models.agent.context import AgentContext  # noqa: E402

SAMPLE = Path(__file__).resolve().parent / "sample-result.json"


def main(argv: list[str]) -> int:
    source = Path(argv[1]) if len(argv) > 1 else SAMPLE
    result = json.loads(source.read_text(encoding="utf-8"))

    failures: list[str] = []

    # 1. The fields the adapter reads must exist. Checked against the document
    #    rather than the adapter, so a CLI rename fails here and not in a run.
    for key in ("state", "steps", "usage", "verdicts", "guards"):
        if key not in result:
            failures.append(f"result is missing top-level '{key}'")
    for key in ("inputTokens", "outputTokens", "cacheTokens", "usd", "unpriced", "reported"):
        if key not in (result.get("usage") or {}):
            failures.append(f"result.usage is missing '{key}'")

    # A missing field is THE failure to report. Running the checks below on a
    # document already known to be malformed replaces that message with a
    # traceback, which is the opposite of a useful diagnostic.
    if failures:
        return _report(failures)

    # 2. The adapter must turn that document into a populated AgentContext.
    logs = Path(tempfile.mkdtemp(prefix="arterm-selfcheck-"))
    try:
        (logs / RESULT_NAME).write_text(json.dumps(result), encoding="utf-8")
        agent = ArtermAgent(logs_dir=logs, model_name="anthropic/claude-opus-4-5")
        context = AgentContext()
        agent.populate_context_post_run(context)

        if context.is_empty():
            failures.append("populate_context_post_run left the context empty")
        if context.metadata is None or context.metadata.get("state") != result["state"]:
            failures.append("context.metadata.state did not come through")

        usage = result["usage"]
        if context.n_input_tokens != usage["inputTokens"]:
            failures.append("n_input_tokens != usage.inputTokens")
        # Unknown cost must stay unknown. Reporting 0 for a run whose rates were
        # missing understates it, which is the failure this guards.
        expected_cost = None if usage["unpriced"] else usage["usd"]
        if context.cost_usd != expected_cost:
            failures.append(f"cost_usd should be {expected_cost}, got {context.cost_usd}")

        # 3. harness.json must be written, and must name the two absences that
        #    are claims: no verify gate, no nested sandbox.
        harness_path = logs / HARNESS_NAME
        if not harness_path.is_file():
            failures.append(f"{HARNESS_NAME} was not written")
        else:
            harness = json.loads(harness_path.read_text(encoding="utf-8"))
            if harness["flags"]["verifyCmd"] is not None:
                failures.append("harness.json must record verifyCmd as null")
            if harness["flags"]["sandbox"] is not False:
                failures.append("harness.json must record sandbox as false")
            if "k" not in harness:
                failures.append("harness.json must carry 'k', even when null")
    finally:
        shutil.rmtree(logs, ignore_errors=True)

    if failures:
        return _report(failures)
    print(f"ok — adapter contract holds against {source}")
    return 0


def _report(failures: list[str]) -> int:
    print(f"FAIL ({len(failures)}):")
    for failure in failures:
        print(f"  - {failure}")
    return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
