# Running Arterm under Harbor / Terminal-Bench

Harbor's installed-agent interface is three methods, so measuring Arterm needs
an adapter and no fork of the harness:

```bash
uv venv && uv pip install harbor      # or pip install harbor
bash bench/harbor/pack.sh             # build the tarball the adapter installs
PYTHONPATH=. harbor run -d terminal-bench@2.0 \
  --agent bench.harbor.arterm_agent:ArtermAgent \
  --model anthropic/claude-opus-4-5 \
  -k 5
```

`PYTHONPATH=.` is not optional and is not cosmetic. `--agent` is an import path,
and `harbor` is a console script — the interpreter's `sys.path` starts at the
venv's `bin`, never at the directory you typed the command in. There is no
`bench/__init__.py` (the adapter resolves as a namespace package), so without the
repo root on the path the run dies before Docker is touched with `ValueError:
Failed to import module 'bench.harbor.arterm_agent': No module named 'bench'`.
Run it from the repo root, or point `PYTHONPATH` at the root by absolute path.

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
PYTHONPATH=. harbor run -d terminal-bench@2.0 \
  --agent bench.harbor.arterm_agent:ArtermAgent \
  --model openai-compat/glm-5.2 -k 1
```

Harbor's own `--env-file <path>` is the better home for both: it `load_dotenv`s
into harbor's process, which is the environment the adapter reads, so the key
never enters shell history. Keep that file OUTSIDE the repo — `.gitignore` has
no `.env` rule, so a key parked in the working tree is one `git add .` from a
commit:

```bash
umask 077 && $EDITOR ~/.arterm-bench-env   # KEY=value lines, no `export` needed
PYTHONPATH=. harbor run … --env-file ~/.arterm-bench-env
```

The name matters twice, and they are not the same name. `OPENAI_COMPAT_API_KEY`
is a HOST-side convenience — one machine can hold a real `OPENAI_API_KEY` for
api.openai.com and a separate key for whatever compat endpoint is being
measured. Inside the container the adapter sets it as `OPENAI_API_KEY`, because
that is what arterm reads: `openai-compat` is the custom-host provider, not a
hosted preset, and `registry.ts` resolves it with
`apiKeyFor("openai-compat", "OPENAI_API_KEY")`. The adapter shipped the literal
name `OPENAI_COMPAT_API_KEY` into the container, which nothing reads — so the
run dialled Z.AI unauthenticated and every request 401'd. It scored as the
agent: `reward 0.0`, `Exceptions 0`, a plausible-looking failure on a hard task.
The tell was `usage.reported: false` with `inputTokens: 0` — a model that never
answered, not a model that answered badly. Read that field before any number.

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

**2. The run must bound its own TIME, not just its steps.** This item used to
say a pinned `--max-steps` was enough — `autonomy.autoExtend` keeps buying steps
while anything happens, and an explicit cap is never extended, so the run would
end by reporting partial work instead of being killed. The first real trial
disproved it: 200 steps were pinned, the cap never bound because the constraint
was the clock, the task's 900s agent budget expired, and `arterm-result.json`
came back 0 bytes — no tokens, no cost, no partial summary. Step duration is not
a proxy for wall-clock; it varies by orders of magnitude across models.

Set `--max-duration` (or `ARTERM_BENCH_MAX_DURATION`) BELOW the task's
`[agent] timeout_sec`, leaving a turn's margin: the ceiling is checked at the
request boundary, so a tool call in flight finishes first — measured overshoot
of 2s on a 45s budget. Past `budget.softRatio` the model is told it is in a
reserve phase and stops starting new work. Keep `--max-steps` as well; it still
bounds a run that spins cheaply. And if the harness kills us anyway, the result
document is now written on SIGTERM. 79% of LH-TB failures are timeouts
(arXiv:2607.08964 §3.4, 518/660) — though those runs average only 0.10–0.35
reward, so what a rescued timeout mostly rescues is the REPORT.

**3. The network policy is part of the score.** It belongs to the Harbor task
config, not to us, and must be reported next to any number. The adapter also
passes `--no-sandbox`: the container is already the boundary, nesting Arterm's
bubblewrap inside it buys nothing and hard-fails wherever nested user namespaces
are refused. That choice is recorded too.

## harness.json

A number without its harness is not comparable to anyone else's, including our
own from last week. Harness-Bench ran 6 harnesses over a shared model pool and
the same tasks and measured **52.4% to 76.2% — a 23.8pp spread**
(arXiv:2605.27922); an ablation on TB2 credits **+7.3pp** to harness structure
(arXiv:2604.25850). The adapter writes `harness.json` into the trial's agent log
dir with the model, agent version, step cap, time budget, roster tier, autonomy
mode, budget ceilings, permission mode, and the two absences above.

Two figures previously quoted here — "46% vs 80%" and "8–21 pass@1 points" —
could not be traced to a primary source and are gone. Read the replacements
against their counterweight: ALE-Claw fixed the model and varied the harness for
a 6.0pp spread, against 18.0pp for varying the model under a fixed harness, and
found that STRIPPING a harness down raised mean score (0.485 vs 0.464) while
cutting 44% of input tokens and 60% of wall-clock. More harness is not better
harness — which is also why `toolsTier` is recorded, and why the smaller roster
is worth measuring rather than assumed to be a handicap.

`k` is not knowable from inside an agent — it belongs to the `harbor run -k`
invocation — so set `ARTERM_BENCH_K` to have it recorded. It is written as
`null` rather than omitted, so a reader can tell "single run" from "we forgot".

Metrics: **`pass@k` for capability, `pass^k` for a regression gate.** On a
~30-task set the 95% band is about ±0.07, so gating on a single run's delta
produces false alarms rather than signal.

## Always dry-run the install first — it is free

```bash
PYTHONPATH=. harbor run -d terminal-bench@2.0 \
  --agent bench.harbor.arterm_agent:ArtermAgent \
  --model openai-compat/glm-5.2 -l 1 --install-only
```

`--install-only` skips the agent run, so **no model is called and nothing is
billed**, while the whole fragile part still executes: dataset fetch, container
start, `apt-get`, nvm, Node 22, `npm i -g` the tarball, and the `arterm
--version` that proves interpreter, launcher and package resolve together in a
fresh exec — which is exactly how `run()` will invoke it.

Read `Exceptions` in the summary table, not `Mean`: with no agent run the mean
is 0.000 either way, and a failed setup shows up only as an exception count.

This is not a formality. The first time it was ever run, it failed —
`readlink -f` on arterm's launcher resolves to the package's own file, whose
directory holds no interpreter, so the `node` symlink pointed at nothing and
every task in every sweep would have died in setup with `exit 127`. A paid run
would have produced ten identical failures and a bill. Two adapter bugs were
found this way before a single token was spent.

Both are also the reason to distrust "the adapter is written" as evidence: it
had a README, a seam check and no end-to-end run.

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
  --max-duration 120 > bench/harbor/sample-result.json
```

`--max-duration` is what puts a `guards.budget` block in the sample, and the
command without it produced a document one block smaller than the one checked
in — so the recipe did not reproduce its own artifact, and the difference read
as a schema change the next time anyone diffed them.
