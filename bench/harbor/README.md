# Running Arterm under Harbor / Terminal-Bench

Harbor's installed-agent interface is three methods, so measuring Arterm needs
an adapter and no fork of the harness:

```bash
uv venv && uv pip install harbor      # or pip install harbor
bash bench/harbor/pack.sh             # build the tarball the adapter installs
harbor run -d terminal-bench@2.0 \
  --agent bench.harbor.arterm_agent:ArtermAgent \
  --model anthropic/claude-opus-4-5 \
  -k 5
```

Docker is required (Harbor runs each task in a container). The adapter installs
Node via nvm and then `npm i -g` the tarball, so tasks need `curl` and a
glibc-based image — the same constraint every Node agent adapter has.

## Credentials, and the endpoint that is not one

The adapter passes the container ONE credential — the variable that provider
needs — because handing a sandbox running model-authored commands every key in
the environment is a different risk than running the benchmark.

The key is read from the ENVIRONMENT, never from `~/.arterm`. An interactive
session keeps its keys in the encrypted keystore, which the container cannot
reach and should not: exporting it for the run is what makes "this run had
access to that credential" a visible decision rather than an inherited one.

`openai-compat` and `ollama` also need their ENDPOINT, and it is not a
credential — those two providers are *defined* by an address, while the rest
have one fixed vendor URL compiled in:

```bash
export OPENAI_COMPAT_API_KEY=…                       # your key, this shell only
export OPENAI_COMPAT_HOST=https://api.z.ai/api/coding/paas/v4
harbor run -d terminal-bench@2.0 \
  --agent bench.harbor.arterm_agent:ArtermAgent \
  --model openai-compat/glm-5.2 -k 1
```

Passing only the key left the container dialing arterm's default
`http://localhost:1234/v1`, where nothing listens — every task failed with a
provider error, and the trial reported that as the agent's score. The adapter
now refuses up front instead, and refuses a `localhost` endpoint too: inside the
task container that names the container, not the machine running harbor, so a
local LM Studio or Ollama needs `host.docker.internal` or a LAN address.

`harness.json` records the endpoint's **origin only** — scheme and host, never
the path or query. "openai-compat" names a protocol, not a model: the same
string reaches Z.AI, a local vLLM and an OpenRouter relay, and they do not score
alike. Path and query are dropped because some gateways carry a token there, and
this file ships next to a published trajectory.

## Why not SWE-bench

OpenAI stopped reporting SWE-bench Verified in Feb 2026: auditing 138 of the 500
problems found ~60% of the failing ones had fundamentally broken tests, plus
contamination. Cursor read 731 trajectories with a blind pass/fail auditor and
found **63% of successful SWE-bench Pro solutions retrieved the fix rather than
deriving it** (57% upstream-PR search, 9% git-history mining); under isolation
controls one model went 87.1% → 73.0%.

The target here is **Terminal-Bench 2.x**, and then
**Long-Horizon-Terminal-Bench** through the same adapter. LH-TB is the one worth
caring about for this codebase: its failure taxonomy is our roadmap written by
someone else — **79% timeout**, **19% early exit from "weak self-verification;
agents stop when the work isn't done"**, plus false finishes. Best model 15.2%,
15-model mean 4.3%. The verify gate and `--persist` make a claim about exactly
that band, and this is the first harness that can score it.

## Three ways to publish a number that isn't the number

The adapter is built around avoiding these; each is enforced in code, not by
convention.

**1. Never pass `--verify-cmd`.** A task's `tests/test.sh` is the hidden grader.
Aiming our own verification gate at it converts "did the work" into "made the
grader pass" — reward hacking, and Terminal-Bench trajectories are published and
read. The adapter has no flag to set one, and `harness.json` records
`verifyCmd: null` so the absence is a stated claim rather than an omission.

**2. `--max-steps` must be a hard cap.** `autonomy.autoExtend` keeps buying
steps while anything is happening, so under a task timeout the trial gets killed
mid-work and reports nothing. An explicitly pinned `--max-steps` is absolute in
Arterm (never extended), which makes the run end by *reporting partial work*
instead. Given 79% of LH-TB failures are timeouts, this is most of the gap.

**3. The network policy is part of the score.** It belongs to the Harbor task
config, not to us, and must be reported next to any number. The adapter also
passes `--no-sandbox`: the container is already the boundary, nesting Arterm's
bubblewrap inside it buys nothing and hard-fails wherever nested user namespaces
are refused. That choice is recorded too.

## harness.json

The same model scores **46% vs 80%** depending on scaffold, and a harness change
moves pass@1 by **8–21 points**. A number without its harness is not comparable
to anyone else's, including our own from last week. The adapter writes
`harness.json` into the trial's agent log dir with the model, agent version,
step cap, autonomy mode, budget ceilings, permission mode, and the two absences
above.

`k` is not knowable from inside an agent — it belongs to the `harbor run -k`
invocation — so set `ARTERM_BENCH_K` to have it recorded. It is written as
`null` rather than omitted, so a reader can tell "single run" from "we forgot".

Metrics: **`pass@k` for capability, `pass^k` for a regression gate.** On a
~30-task set the 95% band is about ±0.07, so gating on a single run's delta
produces false alarms rather than signal.

## Checking the seam

The adapter parses a JSON document our TypeScript CLI writes. No type system
spans that, so a rename shows up as a run that quietly reports zero tokens and
no cost — a plausible-looking wrong number. `selfcheck.py` asserts it directly:

```bash
python bench/harbor/selfcheck.py                 # against the checked-in sample
python bench/harbor/selfcheck.py /tmp/run.json   # against a live run's output
```

Regenerate the sample from a real run (no API key needed) when the CLI's
`--json` shape changes:

```bash
node scripts/fault-server.mjs --mode ok --tool task_done --port 8151 &
arterm --print --json --goal "say hi" --autonomous --no-sandbox --max-steps 2 \
  > bench/harbor/sample-result.json
```
