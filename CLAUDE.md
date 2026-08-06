# CLAUDE.md

Contributor / AI guide for **Arterm-CLI** — a terminal AI coding agent that runs
local models (Ollama over HTTP, or a GGUF directly via `node-llama-cpp`). See
[README.md](./README.md) for user-facing docs.

## Monorepo layout

pnpm + TypeScript (ESM) workspace. Packages live under `packages/`, and the
dependency direction is one-way — **everything depends on `core`**:

| Package             | Responsibility                                                            |
| ------------------- | ------------------------------------------------------------------------- |
| `@arterm/core`      | Shared types, agent loop, config, event bus, permissions, tool protocol.  |
| `@arterm/providers` | `OllamaProvider`, `LlamaCppProvider`, and their registry.                 |
| `@arterm/tools`     | File & shell tools and their registry.                                    |
| `@arterm/tui`       | The Ink terminal UI.                                                       |
| `@arterm/cli`       | The `arterm` binary (commander) and session wiring.                       |

`core` defines the interfaces (`ChatProvider`, `Tool`, `Message`, etc.); the
other packages implement them. Don't add a dependency from `core` onto any other
workspace package.

## Key commands

```bash
pnpm install            # install workspace deps
pnpm -r build           # build every package (tsup)
pnpm -r typecheck       # tsc --noEmit across packages
pnpm -r test            # vitest run across packages
pnpm exec biome check . # lint + format check
pnpm exec biome format --write .   # apply formatting
```

Root scripts mirror these: `pnpm build`, `pnpm typecheck`, `pnpm test`,
`pnpm lint`, `pnpm format`, and `pnpm arterm` (runs the CLI via the `@arterm/cli`
filter).

Out-of-band, after a build:

```bash
node scripts/provider-resilience-e2e.mjs   # fault injection against the real binary
```

```bash
node scripts/sdd-context-e2e.mjs               # what an /sdd worker is actually sent
SDD_E2E_CONTEXT=off node scripts/sdd-context-e2e.mjs   # same run, context disabled
```

It drives the real TUI in a pty through a whole `/sdd` run against a recording
fake model, then asserts on the request bodies: the spec and the dependencies'
output reached the sub-agents. The `SDD_E2E_CONTEXT=off` run reproduces the
pre-fix dispatch and must FAIL the context assertions — a context test that
passes with the context switched off proves nothing. It also asserts on the
screen, which is how the duplicate fleet board and the prompt boilerplate
bleeding into the transcript were found; neither is visible to a unit test.

`provider-resilience-e2e.mjs` runs the built `arterm` against a fake
OpenAI-compatible server that drops
sockets, returns 401/429/503, and dies mid-answer, asserting both what the user
sees and how many requests actually reached the server. It is separate from
`pnpm test` because it spawns a real process — the only way to catch bugs that
depend on process lifetime (an unref'd backoff timer once let the CLI exit 0
mid-retry with no answer and no error, which no in-process test could see).

To drive the same faults **by hand** — against the TUI, or while curling the
status server — start the standalone fake instead:

```bash
node scripts/fault-server.mjs --mode quota-long          # see its header for the modes
OPENAI_COMPAT_HOST=http://127.0.0.1:8099/v1 arterm -p openai-compat -m fake
ANTHROPIC_BASE_URL=http://127.0.0.1:8099 ANTHROPIC_API_KEY=x arterm -p anthropic -m fake
```

It answers normally for one model (`backup` by default), so configuring
`{"fallbackModels": [{"model": "backup"}]}` gives the chain somewhere to land.
Read its request log rather than just the TUI: the gap between the refusal and
the fallback is the thing the short-circuit exists for, and only the log shows it.

## Conventions

- **ESM only** (`"type": "module"`). No CommonJS.
- **`verbatimModuleSyntax`** is on — use `import type { … }` for type-only
  imports, and keep value vs. type imports separate.
- **Import local files with the `.js` extension**, even though the source is
  `.ts` (e.g. `import { Agent } from "./agent.js"`). This is required by the
  bundler/Node ESM resolution; the build keeps the `.js` specifier.
- **Biome** is the formatter/linter: double quotes, semicolons, 100-column width.
  Run `biome check .` before committing.
- TypeScript is **strict**, with `noUncheckedIndexedAccess` and
  `noImplicitOverride`. Index access can be `undefined` — handle it.
- Tests are **vitest** (`*.test.ts`); the CLI package passes with no tests via
  `--passWithNoTests`.

## How-to: add a tool

1. Create `packages/tools/src/<name>.ts` implementing the `Tool` interface from
   `@arterm/core`: `name`, `description`, `parameters` (a JSON Schema object),
   `permission` (`"allow" | "ask" | "deny"`), an optional `preview(args)` for the
   permission prompt, and `async execute(args, ctx)` returning a `ToolResult`
   (`{ output, isError? }`).
2. Use the working directory from `ctx.cwd`; for path-taking tools, resolve and
   confine paths via the helpers in `packages/tools/src/paths.ts`
   (`resolveWithin`, `requireString`).
3. Choose the right default `permission` — read-only tools are `"allow"`; tools
   that write files or run commands are `"ask"`.
4. Register it in `packages/tools/src/registry.ts`: import it and add it to the
   array returned by `defaultTools()` (and re-export it).
5. Add a test in `packages/tools/src/tools.test.ts`.

## How-to: add a provider

1. Create `packages/providers/src/<name>.ts` implementing the `ChatProvider`
   interface from `@arterm/core`: a readonly `id`, `supportsNativeTools(model)`,
   `listModels()`, and an `async *chat(req)` that yields `ChatChunk`s
   (`{ type: "text", delta }`, `{ type: "tool_call", call }`, `{ type: "done",
   usage? }`).
2. If the model exposes a native function-calling API, return `true` from
   `supportsNativeTools` and emit `tool_call` chunks; otherwise return `false`
   and the agent uses the JSON tool-call fallback parsed from the text body.
3. For optional/native dependencies (as with `node-llama-cpp`), import them
   lazily via `await import(...)` and throw an actionable error if missing —
   don't make them a hard install requirement.
3b. **Never let a vendor SDK own the retry loop.** Disable it (`maxRetries: 0`)
   and route the SDK's transport through `fetchWithRetry` instead, as
   `anthropic.ts` does. SDKs typically obey `Retry-After` verbatim with no cap —
   the Anthropic SDK's own comment is "just do what it says" — so a one-hour rate
   limit becomes a one-hour `sleep` *inside* the provider, where the fallback
   chain cannot see it and the user sees a turn that simply never ends. Whatever
   the SDK does with the final response is fine; the waiting has to be ours.
4. Wire it into `packages/providers/src/registry.ts`: add a `case` in
   `createProvider()` and include it in `allProviders()`.
5. If it needs config (host, paths, etc.), add fields to `ArtermConfig` in
   `packages/core/src/config.ts` with defaults in `defaultConfig()`.

## Kernel: the agent loop is pipeline-driven

`packages/core/src/kernel/` holds a tiny DI layer that the agent loop runs on:

- **`Container`** — lazy, memoized typed DI (`bind`/`override`/`decorate`/`resolve`,
  plus `createScope` for per-run children). `buildSession` (in `@arterm/cli`) is the
  composition root: it builds the root container and binds the session's services
  (`Tokens.Bus`, `PermissionPolicy`, `Compactor`, `Pipelines`, `RunController`, …) to
  the instances it already creates, then hands that container to the `Agent`. An
  `Agent` constructed without one (sub-agents, tests) falls back to an internal
  `defaultAgentContainer()`.
- **`RunController`** — owns each turn's lifecycle. `Agent.run()` calls
  `runController.begin()` and uses the returned `RunHandle`'s `signal` everywhere; the
  caller's `signal?` is **linked** into the handle (not threaded directly), so
  `run(input, signal?)` is unchanged while cancellation has one source of truth.
- **`Pipeline`** — named, ordered Koa-style middleware chains. The loop's seams are six
  pipelines (`userInput`, `request`, `response`, `assistantOutput`, `toolCall`,
  `contextWindow`). The `Agent` installs its built-in behavior as **named default
  stages** in `installDefaultPipelines()` (e.g. `request.buildSystem`,
  `response.recoverToolCalls`, `toolCall.permission` + `toolCall.execute`,
  `contextWindow.autoCompact`). Each is guarded by `pipeline.has(name)`.

### How-to: change or extend loop behavior

Don't edit the `run()` loop. Instead add/replace a middleware stage:

1. Pick the pipeline for the seam (e.g. `toolCall` to gate or wrap execution,
   `request` to shape the prompt, `contextWindow` to change compaction policy).
2. To **add** behavior, register a new named stage before the agent constructs (bind a
   `Tokens.Pipelines` whose chain already `.use("yourStage", mw)`), or `before`/`replace`
   an existing one. To **override** a default, register a stage with the SAME name the
   agent uses — `installDefaultPipelines()` skips installing its own when `has(name)` is
   true.
3. A stage that omits `await next()` short-circuits the rest of the chain (this is how
   `toolCall.permission` denies a call). Stages mutate the shared `Ctx` object; the
   per-stage context shapes live in `kernel/pipeline.ts`.
4. The Brain Arbiter / risk-tier checks are the canonical extension point: extra
   `toolCall` middleware inserted `before` `execute`.

## Verification: one gate, two parts

`packages/core/src/verify.ts` decides whether a produced result is acceptable. It
composes a **deterministic command gate** with an **LLM judge behind it**, and the
two have deliberately opposite failure policies:

- The command **fails closed**. An exit code is not an opinion, so it may block.
- The judge **fails open**. Unreachable, confused, or too small to emit a tool
  call — all accept the claim. Treating a judge's silence as a rejection turns
  every infrastructure hiccup into lost finished work.

That asymmetry is what makes verification safe to have on by default. Keep it.

**The verdict is data, never prose.** The judge reports by calling
`submit_verdict`, and the caller reads the arguments off the sub-agent's private
bus (`captureVerdict`) — upstream of the permission pipeline, so a denial or a
short-circuiting middleware cannot silently swallow it. The whole rule is:

```ts
verdict !== undefined && verdict.pass === false   // the only thing that blocks
```

Do not add a text check anywhere near this. `runSubagent` *returns* a failure
string rather than throwing, so any "does the output say PASS" test reads a dead
API key as a rejection — which is the bug this replaced.

A rejection is never upgraded: `pass: false` with no `mustFix` still blocks, and a
terse summary never invalidates a verdict. `refs` is reported, never gated on;
`inspected` (the judge's non-verdict tool calls) is the evidence signal, because
an integer cannot misfire the way a "does this sound vague" regex can.

**`extractVerifyCommand` is the security boundary** — the one place free text
becomes a command. It demands a whole line reading `verify: <cmd>`; prose that
merely mentions verification yields nothing. The command reaches `sh -c` as a
single positional argument (never `shell: true`), so the shell interprets
metacharacters rather than Node.

A marker is the only command *model output* can supply, and it is optional — so
without one the gate is a no-op and acceptance rests on a judge that only reads.
`verify.command` (or `--verify-cmd`) is the **standing gate** that closes that:
the fallback the command verifier runs when the work declared nothing. It comes
from config or argv, never from the model, and a declared `verify:` line still
wins — so a worker can narrow the gate to its own task and can never widen or
remove it. It fires at every completion boundary, so a whole-repo suite there is
paid once per phase/round. Prefer `--verify-cmd` to the config field: config is
global (`~/.arterm/config.json`), and `pnpm -r test` as a permanent gate fails
closed in every directory without pnpm.

`verify.persist` (or `--persist`) stops a run from *giving up* after
`verify.attempts` rejections. It changes nothing else: the `mustFix` note was
already queued, so the loop simply takes another lap, and the mode's own bound
(`autonomy.maxSteps`, `maxPhases`, `team.maxRounds`) is still the ceiling. Every
mode asks `outOfAttempts()` rather than comparing counters, which is what keeps
one meaning across all five — except the phased per-phase retry loop, which
re-runs the phase itself and so has no outer bound to fall back on. That one
stays capped on purpose.

`arterm --print --goal "…"` runs the loop headlessly and streams its verdicts —
the scriptable way to exercise any of this without a terminal. Add `--json` for a
structured run + verdict list, plus a `guards` block (`loopSteers`, `loopCuts`,
`extensions`). That block is not decoration: without it a run the loop detector
killed twice printed `state: stopped` and an empty `verdicts` array, which reads
exactly like a run that simply had nothing to do. Steers and cuts are counted
rather than listed, because a long run repeats them per turn and an unbounded
array would bury the verdicts beside it. The self-contained way to see a whole
gated run, no API key and no real model:

```bash
node scripts/fault-server.mjs --mode ok --tool task_done --port 8131 &
arterm --print --json --goal "…" --verify-cmd 'node -e "process.exit(3)"' --persist
```

`--tool task_done` is what makes the fake model *claim* completion, which is the
only thing that puts the gate on the path at all.

`AutonomyEngine.gateClaim()` is the single call site for every mode. A rejection
queues its `mustFix` items into `pendingSteer`, which every mode's prompt builder
already consumes — that is why no mode needs its own repair plumbing. `eternal`
is exempt by default: it never makes a completion claim. Setting
`autonomy.eternalCompletion: "claim"` opts it in — a claim then passes the same
gate, an acceptance ends the run, and a rejection just keeps looping (persist is
inherent; eternal never consults `outOfAttempts()`).

## Unattended runs: `--autonomous` and the guards behind it

`--autonomous` flips the five switches an unattended run needs — yolo
permissions, `verify.persist`, `fleet.autoApprove` (sub-agents get a fail-closed
policy from `subagentPolicy()` instead of blocking on a prompt no one will
answer), `autonomy.autoExtend`, and the loop detector — and announces itself on
stderr. Explicit per-tool `deny` overrides and the arbiter's critical block
still win: they sit above yolo in `evaluate()`, and the sub-agent asker answers
"deny", never hangs.

The loop detector is the one switch that **overrides** an explicit
`loopDetect.enabled: false` rather than defaulting under it, with its own
warning when it does. The combination it forecloses is arithmetic:
verify-persist keeps the run alive after rejections, auto-extend counts each
verification attempt as progress, so with the detector off a run failing the
same gate forever earns an extension forever — observed running unbounded until
an external timeout killed it. Attended runs keep whatever the config says; an
undetected unattended run is available only as bare `--yolo`, which promises
nothing.

It also warns when there is **no standing gate** — no `--verify-cmd` and no
`verify.command` — because that run accepts completion on the judge alone, and
the judge only reads the result. It never sees the diff, so it cannot catch work
that contradicts the goal. Observed, not theorized: a fleet worker told not to
change `slug()`'s behavior rewrote the function, committed it as `docs(…)`, and
the judge passed it with "the function's behavior was not touched". An exit code
was the only part of the gate that could have known. The warning is deliberately
not a refusal — many goals have no command that can judge them, and making
`--autonomous` unusable without one just pushes people to bare `--yolo`, which
announces nothing. `verify.enabled: false` gets its own, blunter warning, since a
configured `verify.command` is irrelevant when the layer that runs it is off.

Note also what `--autonomous` licenses: yolo clears `git_commit`, so an
unattended run can and does write to git history on its own.

What keeps an unattended run from spinning is not the cap but the guards
(the WrongStack lesson — see `loopDetector.ts`):

- The **loop detector** (default stages `response.loopDetector` +
  `toolCall.repeatWindow`, config `loopDetect`) steers at 3 identical
  repetitions and cuts the turn at 5, for the main agent and sub-agents alike.
  Its iteration fingerprint deliberately survives turn boundaries — eternal
  steps are separate turns repeating one directive, and text-only replies are
  skipped, not resets, for the same reason.
- **`autonomy.autoExtend`** turns the step cap into a progress gate: at the cap
  the run gets `extendBy` more steps only if tool calls or verification
  attempts happened since the last grant. `--max-steps` is the exception: an
  explicitly pinned cap is absolute (`hardCap`) — it bounds eternal too and is
  never extended, which is what makes eternal runs testable in CI.
- **Eternal continuation mechanics**: a 5-entry journal of classified steps
  (`ok|idle|error|loop|verify-fail`) is prepended to every directive; after
  `failureBudget` consecutive non-ok steps the engine pivots (asks `plan()` for
  ONE different task and queues it as steer); retryable provider errors get
  2s→60s abort-aware backoff; a provider that never once succeeded stops the
  run after two exhausted budgets instead of hammering silently forever.

When testing any of this against `fault-server.mjs` with a reused sandbox HOME,
pin `openaiCompatHost` in that HOME's config per run: the CLI persists the full
config on exit, so a stale saved host silently redirects the next run away from
your fake server (zero requests, instant provider errors).

**A `/sdd` worker's prompt is the task plus its context, built in `taskPrompt()`:**
the spec the graph was cut from (`specBlock()`) and the quoted output of every
dependency that finished (`upstream()` → `handoff()`), with the verify-gate line
last. The dependency outputs are the only channel between waves — a wave-2 worker
is a fresh sub-agent with no memory of wave 1, and under `fleet.isolation:
"worktree"` it cannot read wave 1's files either. Clipping keeps both ends of an
over-budget text: the conclusion is at the bottom, so a plain `slice(0, n)` throws
away the part that matters most.

`specBlock()`'s scope sentence ("implement ONLY the task above") is load-bearing,
not padding. Handing a worker the whole design invites it to build the whole
design, and two workers writing the same section concurrently is worse than either
doing it alone. `execute(graph, spec?)` takes the spec as a parameter rather than
reading instance state, so the fleet prompt is a pure function of what it is given.

**The judge runs where the worker wrote.** Never in a fresh worktree —
`createWorktree` bases on `HEAD`, i.e. a tree with the change absent, where a
verifier passes trivially. `/sdd` verification is therefore skipped entirely when
`fleet.isolation` is `worktree` and `mergeStrategy` isn't `apply`.

## The sandbox: the one control `--autonomous` adds

Every other switch `--autonomous` flips removes a control. `sandbox.ts` (policy,
in `core`) plus `tools/src/sandbox.ts` (mechanism, over
`@anthropic-ai/sandbox-runtime`) is the one that puts something back: `bash` runs
confined to the session's write roots with egress restricted to an allowlist.
The permission ladder cannot cover this ground — it decides *whether* a command
runs, and yolo has already answered yes; it has nothing to say about what an
allowed command can then reach.

**The boundary never comes from model output.** Write roots are derived at boot
from the session cwd and `realpath`'d; `wrap()` refuses a `cwd` outside them
rather than widening to fit the caller. This is the most-repeated root cause in
the 2025–26 incident record — CVE-2025-59532 (Codex CLI) used the model's `cwd`
as the writable root, and Cursor's CVE-2026-50548 was the same bug again. A
boundary a tool call can name is not a boundary. `withinWriteRoots` compares
after `realpath` on both sides, because a prefix test on unresolved paths is what
`/proc/self/root/...` walked through in the bubblewrap escape.

The fail policy is asymmetric, and mirrors `verify.ts`: **unattended fails
closed, attended fails open.** A warning is a control only if someone reads it,
and `--autonomous` is defined by nobody being there — so `buildSession` throws
before the agent exists, meaning the run did nothing rather than "did some of it,
unconfined". An attended session warns and continues, because a boundary that
breaks a developer's own toolchain gets switched off permanently the first time
it does. `--no-sandbox` is a real, loud escape hatch for the same reason
`--verify-cmd` is a warning and not a refusal: making `--autonomous` unusable
without it pushes people to bare `--yolo`, which announces nothing.

Defaults worth knowing: the allowlist lives in `defaultConfig()`, **not** in
`resolveSandbox`, so `allowedDomains: []` in config means deny-all rather than
"fall back to the defaults". The OS temp dir is a write root on purpose — build
tools write there, and so do `fleet.isolation: "worktree"` workers, so isolation
and confinement compose instead of the boundary refusing every `/sdd` command.

`bash` spawns the wrapped **argv** directly, never through `shell: true`: the
wrapper does its own quoting, and a boundary that depends on quoting surviving
two shell passes is not one. A refusal is an error result, never a fall-through
to an unsandboxed run.

The vendor dep must be declared in **both** `@arterm/tools` and `arterm-cli`.
The CLI's tsup inlines `@arterm/*` but externalizes its own dependencies; an
undeclared one gets bundled into the single-file binary, where its CJS internals
die at runtime with `Dynamic require of "crypto" is not supported`. That failure
is invisible to `pnpm test` and typecheck alike — it only appears when the built
binary runs, which is what the e2e scripts exist for.

## Telemetry: `gen_ai.*`, pinned

`core/src/telemetry.ts` is the MAPPING (which seam becomes which span, under
which attribute names); `cli/src/otel.ts` is the MECHANISM (the OTLP exporter,
lazily imported). Same split as the sandbox, for the same reason: `core` takes
no dependency on OpenTelemetry, and a session with telemetry off pays nothing.

**Model and tool spans come from PIPELINE STAGES, not from the bus.** Duration
is the whole point — `gen_ai.client.operation.duration` is what an operator
alerts on — and deriving it from bus events folds tool time into the provider's,
producing a latency graph that is wrong in the direction that hides a slow
provider behind a slow tool. The `request`/`response` pipelines bracket exactly
the provider call; `toolCall.before("execute")` brackets exactly one execution.
The turn-level `invoke_agent` span is the one with no pipeline around it, so
that one legitimately comes from `turn_start`/`turn_end`.

**Attribute names are pinned to one semconv release** (`GENAI_SEMCONV_VERSION`),
stated on every export as a resource attribute. The GenAI conventions are
pre-stable and have already renamed keys under people — `gen_ai.system` became
`gen_ai.provider.name` — and emitting a mix of two vintages is worse than
emitting one old one consistently: a dashboard can migrate a known version, but
it cannot group by a key that is sometimes one string and sometimes another.

**Telemetry never fails a run.** The opposite policy to the sandbox's, on
purpose: a missing package, a bad endpoint or an unreachable collector degrades
to one stderr line. Observability that can take down what it observes is a worse
trade than none. The flush lives inside `persist()` because that is the last
call on every teardown path, and a batch processor that is never shut down drops
exactly the spans anyone is looking for.

A zero is a measurement: nothing is recorded for a provider that reported no
usage, because contributing zeros drags every percentile beside it downward.
Same reason `budgetMeter` is now installed whether or not a ceiling exists —
spend accounting used to be a side effect of setting a limit, which made every
unlimited run report zero tokens and zero cost.

## Measuring: `bench/harbor/`

`bench/harbor/arterm_agent.py` is a Harbor `BaseInstalledAgent` — the adapter
that runs `arterm` under Terminal-Bench 2.x (and then
Long-Horizon-Terminal-Bench) with no fork of the harness. `bench/harbor/README.md`
carries the operating detail; the parts that are policy rather than plumbing:

**Never give a benchmark run a `--verify-cmd`.** The task's `tests/test.sh` is
the hidden grader; pointing our own gate at it converts "did the work" into
"made the grader pass", and Terminal-Bench trajectories are published and read.
This is the one place in the codebase where the standing gate is deliberately
absent, and `harness.json` records `verifyCmd: null` so the absence is a stated
claim rather than an omission.

**`--max-steps` is what keeps a timeout from erasing the work.** `autoExtend`
buys steps while anything is happening, so under a task timeout the trial is
killed mid-work and reports nothing; a pinned `--max-steps` is absolute, so the
run stops and reports partial work instead. 79% of LH-TB failures are timeouts.

**The container is the boundary, so the adapter passes `--no-sandbox`.** Nesting
our bubblewrap inside Harbor's container buys nothing and hard-fails wherever
nested user namespaces are refused. Both that and the task's network policy go
into `harness.json`, because the same model scores 46% vs 80% across scaffolds
and a harness change is worth 8–21 pass@1 points — a number without its harness
is not comparable to anyone else's, or to our own from last week.

`selfcheck.py` asserts the seam between the CLI's `--print --json` document and
the adapter that parses it. No type system spans that boundary, so a rename on
the TypeScript side would surface only as a benchmark run quietly reporting zero
tokens and no cost. Run it (and regenerate `sample-result.json`) whenever
`HeadlessGoalResult` changes.

That is also why `HeadlessGoalResult.usage` is unconditional while
`guards.budget` is not: a ceiling is optional, spend is a fact. `usage.reported`
distinguishes "the backend reported nothing" from "the run cost nothing" —
without it a local model and a broken meter produce the same row, which is the
`9aaae14` context-gauge lesson in a second place.

## Permissions: one ladder, three callers

`PermissionManager.evaluate()` is the whole policy — a pure function returning
`allow | deny | prompt` plus the trace of every rule it consulted. `check()` calls
it and only adds the human prompt; `arterm permissions explain` calls it for one
proposed call and prints the trace; `arterm permissions list` calls it once per
tool and prints a table. Put new rules **in `evaluate()`**, never in `check()`, or
the inspectors start describing a policy nobody runs.

`createPermissionManager(config)` (in `permissionPolicy.ts`) is the only place
config becomes a policy — `buildSession` and both inspection commands go through
it for the same reason. The optional model gate (`arbiter.model`) is a separate
pipeline stage that runs *before* this ladder and is not part of `evaluate()`.

`list` evaluates with **empty arguments**, so any row the arbiter would judge from
args (`category !== "read"`) is marked `argDependent` and printed with a `*`.
Dropping that marker would make the table read as a guarantee it can't give — in
`auto` mode every row would say "runs", including `bash`.
