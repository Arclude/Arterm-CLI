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
`pnpm lint`, `pnpm format`, and `pnpm arterm` (runs the CLI via the `arterm-cli`
filter).

The workspace root is `arterm-workspace`, and it may never be renamed back to
`arterm-cli` — that is `packages/cli`, the published package. While both answered
to one name, `pnpm --filter arterm-cli test` was ambiguous and resolved to the
ROOT, so a command that reads as "run the CLI's tests" quietly ran `pnpm -r test`
over every package. It was found by an agent whose verify gate was that command:
it was handed two broken CLI tests and had to fix a `core` one as well, because
the gate it was being held to was the whole repository.

Out-of-band, after a build:

```bash
node scripts/provider-resilience-e2e.mjs   # fault injection against the real binary
```

```bash
node scripts/sdd-context-e2e.mjs               # what an /sdd worker is actually sent
SDD_E2E_CONTEXT=off node scripts/sdd-context-e2e.mjs   # same run, context disabled
```

```bash
node scripts/sandbox-lifecycle-e2e.mjs     # does a sandboxed run EXIT when it is done?
```

```bash
node scripts/sigterm-report-e2e.mjs        # does a KILLED run still report what it did?
node scripts/deadline-exit-e2e.mjs         # does a run that hits its deadline STOP, and EXIT?
node scripts/keystore-denyread-e2e.mjs     # can a sandboxed command read our own API keys?
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

`sandbox-lifecycle-e2e.mjs` is the mirror image of that bug, and the reason
`SandboxRunner.dispose()` exists. The boundary is not just rules — it is
host-side PROCESSES (the egress proxy, the socket bridge), whose listeners hold
Node's event loop open. Nothing tore them down, so a headless `--autonomous` run
did the work, passed its gate and printed its JSON verdict, and then never
exited; it had to be killed, which reports as a failed run whatever it actually
accomplished. Every in-process assertion passed. `--autonomous` forces the
sandbox on, so this was every unattended run — and invisible to the Harbor
adapter, which passes `--no-sandbox`. `dispose()` refcounts its holders: one
process can hand the same boundary to several sessions (the TUI's manager does),
so the LAST session out resets, or closing one would unconfine the rest.

`sigterm-report-e2e.mjs` covers the third process-lifetime failure: being
KILLED. A harness that bounds tasks by wall-clock kills the process when the
clock expires, and that took the whole report with it — a real benchmark trial
ended with `arterm-result.json` at **0 bytes**, so fifteen minutes of paid work
produced no token count, no cost and no partial summary, a row
indistinguishable from a run that never started. `runHeadlessGoal` now emits the
document on SIGTERM/SIGINT and exits 128+signal. Three things it gets right and
a rewrite could quietly lose: the emit is `writeSync` (a pipe makes stdout
async, and an async write queued just before `process.exit` never lands); it is
NOT a graceful unwind, because SIGTERM is usually followed by SIGKILL on a short
fuse and unwinding risks dying with nothing written; and the listeners are
removed in the `finally`, or a later run in the same process emits a second
document into somebody else's stdout. The script signals on the first `▸ step`
rather than on a timer — a signal delivered before the first request produces an
empty report that still parses, which is a pass for the wrong reason. Checked
against the pre-fix binary it scores 1/4, and the failing check is `0B`.

`deadline-exit-e2e.mjs` checks the two halves of `--max-duration`, which failed
independently. The ceiling began life as a `request` pipeline stage — correct
for tokens and dollars, which only grow when a request is SENT, and wrong for a
clock, which runs during one. On a benchmark trial that left 120 seconds of
margin entirely unused. Making it abort the turn was still not enough: the
autonomy engine's next call (`assess`, `plan`, a judge sub-agent) carried a
signal that had never been aborted, so the run hung there instead and the
deadline read as having done nothing. Hence `RunBudget.deadlineSignal` — armed
once, shared by every agent and sub-agent in the run, linked by `withDeadline()`
into the calls that bypass the pipeline.

The second half is the exit, and it is the subtler one: **`digest()` runs at
TEARDOWN**, after the loop has stopped and the result document is already on
disk, and it made its own model call with no signal at all. A run that stopped
correctly at 8s then sat for another 80 — and to a harness that bounds by
wall-clock, a run that stops at 8s and exits at 88s is a run that never stopped.
It is now skipped outright when the budget is breached, because bounding the
call is not enough: starting a fresh model call with seconds left buys a
truncated digest at the cost of the exit.

`--mode slow-stream` in `fault-server.mjs` is what makes this testable — a
server that never goes quiet and never finishes. It is deliberately the one
fault `streamIdleGuard` cannot catch: the guard aborts a stream that stops
producing, and every chunk resets it, so a model reasoning for an hour looks
exactly like one making progress. Only a deadline tells "still producing" from
"still useful". Against the pre-fix binary the script scores 3/5 and the process
has to be SIGKILLed.

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
- **A test may never write the developer's `~/.arterm`.** `ARTERM_HOME` is
  resolved ONCE at module load in `core/src/config.ts`, so `$ARTERM_HOME` is the
  only thing that can redirect it — `packages/cli/vitest.config.ts` points it at
  a temp dir, and `configIsolation.test.ts` fails if that redirect disappears.
  This is not hypothetical tidiness: `processE2e.test.ts` builds a session from
  `defaultConfig()` and calls `persist()`, which reset a real config's
  `provider`/`model`/`permissions` to the defaults while leaving every other
  field intact. The file still looked correct — `openaiCompatHost` naming the
  live endpoint beside `provider: "ollama"` — and the next run went to an Ollama
  that was not running, surfacing three layers away as a team leader that
  "proposed no work". Keep the guard test; a lost `vitest.config.ts` is a
  one-line change whose only symptom is somebody's config changing under them.

- **So `homedir()` belongs to exactly one file**, and `configIsolation.test.ts`
  scans every package's `src/` to prove it. The redirect above is worthless to
  code that never consults it: `statusServer.ts` built
  `join(homedir(), ".arterm", "status")` itself, and `statusServer.test.ts`
  CREATES discovery files there and asserts they exist — so the suite wrote into
  the developer's real `~/.arterm/status` on every run, and deleted them
  afterwards, which is why the only trace was an mtime. The first guard could not
  see it, because it knew about one FILE while the mistake is a CLASS. The scan
  matches the import rather than the word, so the sentence explaining the rule
  does not trip it, and it names the offending path instead of counting it. It
  also decides whether a confined run can test itself at all: `~/.arterm` is not
  one of the sandbox's write roots, so under `--autonomous` a path built from
  `homedir()` is not merely unredirected, it is unwritable.

- **And the redirect is per PACKAGE**, so `configIsolation.test.ts` asserts every
  package that runs tests sets `ARTERM_HOME` in its own `vitest.config.ts`.
  `packages/cli` had one and `packages/core` did not, which is how a single
  `agent.test.ts` case spooled a real file into `~/.arterm/tool-output` —
  counted: 240 files before, 241 after. `packages/tui` is why the check is about
  the SETTING rather than the file: it already had a config, for `FORCE_COLOR`,
  and its existence is exactly what stopped anyone opening it. The rule is
  blanket on purpose; an exception list is a place for the next package to be
  forgotten. This was the third instance of one mistake — `config.json`, then
  `status/`, then `tool-output/` — which is what moved the guard from naming
  files to naming the rule.

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

### Prompt caching: a turn is not one request

The loop re-sends the whole prompt on **every tool call**, so the reusable part
is billed again each iteration, unchanged. Measured on a real session against a
capturing endpoint: 59 tools (the roster plus what the session adds at runtime)
and the system prompt come to **10,662 tokens of fixed prefix per request** —
223k tokens over a 20-call turn, for text that never varied.

`anthropic.ts` marks all four breakpoints Anthropic allows: the last tool (which
seals the whole roster, since a breakpoint caches everything before it), the last
system block, the last message, and the end of the most recent COMPLETED tool
round-trip. A write costs 1.25× and a read 0.1×, so the break-even is a single
reuse — the second iteration of the first turn.

The fourth was left unspent for a long time, on the argument that a second
anchor further back "would have to GUESS where the previous request ended" —
an iteration appends an assistant turn plus one tool result per call, so the
offset is not fixed, and a breakpoint on a position that never repeats is a
cache write nobody reads. That objection is about counting BACKWARDS by a fixed
number of messages, and it dissolves once the position is computed from the
conversation's shape. `completedTransactionIndex` finds the
`user(tool_result…)` message that a later assistant turn has already answered:
everything up to it is frozen for the rest of the run, so it is the longest
prefix guaranteed to be re-sent byte-identical on every remaining request.
Anthropic matches the LONGEST cached prefix, so the older anchor earns its keep
exactly when the newest one misses — an expired entry, or a history the
compactor rewrote from the tail. `withCacheBreakpoints` never marks the same
message twice, because two markers on one position spend one of four to buy
nothing.

Three things are load-bearing:

- **A string cannot carry a breakpoint.** `toAnthropicSystem` switches to blocks
  when caching, and keeps the plain string otherwise — blocks buy nothing
  without a marker, and changing the wire for no gain is how a working path
  breaks. `OAUTH_SYSTEM_IDENTITY` must still lead, the marker must still trail.
- **Never manufacture an empty text block to hold a marker.** Anthropic 400s the
  whole request on one, so `withCachePoint` returns the message untouched when
  there is nothing to attach to. Not caching one message beats losing the turn.
- **`thinking` blocks take no `cache_control`.** The narrowing in
  `withCachePoint` is the type system stating which blocks a breakpoint can ride
  on, rather than a cast asserting it.

`promptCache: false` is the escape hatch, and it exists for `baseUrl`: a relay
that validates against an older schema rejects `cache_control` outright, and a
400 on every turn is worse than paying full price. This is Anthropic-only —
OpenAI and its compatibles cache prefixes server-side with nothing to opt into,
and `openai-compat.ts` already reads back `prompt_tokens_details.cached_tokens`.

The accounting was already right before the markers existed: `cache_read` and
`cache_creation` are reported separately and never folded into `promptTokens`,
because a read costs ~10% of the input rate and merging them overstates an agent
loop — which is mostly cache hits — by close to an order of magnitude.

### Reasoning is a THIRD chunk kind, and it is never recorded

`ChatChunk` has `thinking` beside `text` because the two have opposite fates.
`text` accumulates into the assistant message, which becomes the transcript, the
next request's history, and every later compaction. Reasoning is displayed,
metered, and DROPPED — folding it into the answer would re-send the model's
working notes for the rest of the session, and re-bill them each turn.

`openai-compat.ts` reads `reasoning_content`, falling back to `reasoning`. That
field is not in the OpenAI spec: it is the convention DeepSeek introduced and
Zhipu/GLM, Moonshot and most compatible reasoning backends copied, so it arrives
on the same endpoint under one of two names and is simply absent otherwise.
Reading a field a server never sends costs nothing — NOT reading it cost the
user twice: billed as output tokens, and invisible.

That invisibility was the actual bug. A backend streaming only
`reasoning_content` sends no answer text for as long as it thinks, so the screen
showed a spinner and nothing else — indistinguishable from a hung request.
`ThinkingPreview` says WHAT is happening, and it obeys the same constant-height
contract as `LiveMessage`: the region is redrawn on every chunk, so one that
grows a row leaks the row it grew past into the terminal's scrollback.
`wrap="truncate-end"` is part of that contract, since a wrapped long line is two
rows and not one. One region or the other renders, never both.

Anthropic's extended thinking is deliberately NOT wired yet. It is not the same
feature: with tools, the API requires the assistant's thinking blocks be passed
back with their signatures, which means reasoning that *is* recorded — the exact
inverse of the rule above — and getting it wrong fails the request rather than
degrading quietly.

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

### Concurrency is the loop's, not a stage's

The one thing a `toolCall` stage cannot do is overlap a call with its SIBLINGS —
a middleware sees one call. So `planToolBatches` (`toolBatch.ts`, pure and
tested on its own) sits in `run()`, and the loop is the only place that decides
what runs together. Measured on four concurrent `grep`s over this repo: 162ms
serial, 91ms parallel, **1.79×**. A turn is mostly waiting.

**The TOOL declares `concurrent`, and absent means no.** `category: "read"` is
not this question and cannot be made into it — it drives the auto/plan
permission modes, and several tools carrying it change session state anyway:
`set_working_dir` moves the cwd every later path resolves against, `todo` and
`remember` write stores, `batch` dispatches other tools and can reach an edit
through one. Reading concurrency off the category would have parallelized all of
those. The bar is not "does not write files" but "its result cannot depend on
whether it ran before or after its siblings" — `git` fails it despite being
read-only, because `git status` takes `index.lock` to refresh the index.

`canRunConcurrently` adds two clauses to the tool's own, each for a different
reason. `category === "read"` because the arbiter screens `execute` calls and a
screen can escalate to a prompt. And the ladder must answer `allow` OUTRIGHT:
`evaluate` is pure and returns `prompt` as a distinct outcome, which is exactly
what must not happen eight times at once into one terminal.

Two properties are load-bearing, and both are what the tests pin:

- **Batches are RUNS, not a partition.** A safe call is never hoisted past an
  unsafe one between it and its neighbours. Pulling the cheap reads forward
  would reorder a turn whose author wrote it in an order for a reason, and the
  failure surfaces as a tool seeing a file before the edit meant to precede it.
- **Every execution finishes before ANY result is recorded.** History reads in
  the order the model asked, never the order the disk answered — a transcript
  that reorders run to run is unreproducible, and a provider that pairs
  `tool_use` with `tool_result` by position is simply given the wrong answer.
  This is why `executeToolCall` and `recordToolCtx` are separate.

`MAX_CONCURRENT_TOOLS` is a resource bound, not a correctness one, and the
overflow continues in the next batch rather than being dropped — a silently
truncated turn leaves `tool_calls` with no matching result, which native APIs
reject. Nothing about the event stream changed: `tool_call` is emitted while the
response streams, before any execution, so the transcript's shape is what it was.

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

**A failed merge leaves NOTHING behind** (`applyPatch`, `worktree.ts`). The
mechanism is `git apply --3way`, which on conflict does not simply refuse: it
writes the conflict markers into the working tree, stages the conflicting blobs,
*and* exits non-zero. So the caller was correctly told "this did not apply" while
the user's source files had already been replaced with text that does not parse.
Seen on a three-member `/team` run where each member implemented all three
modules in its own worktree: every one of the three merged files came out
starting with `<<<<<<< ours`, and the run carried on. The member's BRANCH is the
recovery channel that mode deliberately keeps — a half-merged working tree is
the one outcome nobody asked for — so the paths the patch names are snapshotted
before the apply and restored (including deleting a file that had to be created)
when it fails.

**The leader is visible while it thinks** (`leader_call`, emitted around
`Agent.plan()`/`assess()`). It is the one agent with no cell on the swarm board,
by design — but `plan()` emits no `turn_start`, so between rounds the screen
showed a finished board (`3/3 done · 0 LIVE`), a frozen step counter and an idle
status bar while the call deciding the entire next round ran for minutes. Every
signal on screen said "done" at the exact moment the most important call of the
run was in flight. `turn_start` cannot carry this: it brackets a turn and the
telemetry layer turns it into the `invoke_agent` span, and a planning probe is
neither.

`plan()` is still best-effort — an unreachable leader returns an empty plan so
the tolerant parsers fall back and the loop keeps control — but it is no longer
SILENT. Swallowing the exception turned "the provider refused every call" into
`"no further team work proposed"`, printed as a summary, with exit 0. Both it and
`assess()` also meter their usage now; reading only the `text` chunks is why a
whole `/team` run reported `usd: 0, reported: false` when every token it burned
was the leader's.

**`readAssessment` reads the verb position, not the prose** — the completion
check's half of the rule the result verifier states one layer up. `assess()`
asks for one word, and the parse was `/\bDONE\b/i.test(text)`, so this reply
ended a run:

> "Let me verify the actual state of the main working tree before declaring done."

That is a model saying it is NOT finished. Only the first word of the first or
last non-empty line counts now (last as well as first because a model that
reasons before answering puts the verdict at the bottom), stripped of the
markdown a one-word answer gets wrapped in. Unreadable means NOT done, and the
asymmetry is the same one as everywhere else here: the next step is
`gateClaim()`, so a false "done" spends a verification round-trip and — with no
standing gate configured — ends the run on a misreading, while a false "not
done" costs one more lap of an already-bounded loop.

**A finished fan-out run reports the CLAIM it was gated on**, not `verdict.note`.
The note is one word by design, so the summary field was at best `"DONE"`; the
claim adds a ✓/✗ line per worker. `recordRound` takes the ASSIGNMENT map rather
than reading `result.task`, because a team member's `task` is the assignment
buried under its private-memory recall and the blackboard brief — quoting its
first 120 characters produced `✗ upper-writer: [Your private memory — earlier
rounds, visible only to you]`, in the summary AND in what the judge was asked to
check. Parallel mode passes no map, because there `decompose()` hands its
subtasks to the fleet unwrapped and the task IS the assignment.

**The claim is the whole run, not the round that ended it.** Rows accumulate in
`roundRows` as each round lands, and `roundClaim()` renders all of them — the
last round's claim alone reported a six-round team run as the work of whoever
ran last, hiding both the earlier members and any ✗ among them from the summary
and from the gate. One round prints bare rows; several get `Round N:` labels,
because "who did what" is only answerable together with "and when". The budget
is `MAX_CLAIM_ROWS` and it drops whole rounds from the FRONT, keeping the tail a
reader wants first, and it SAYS how many it dropped — parallel mode's rounds are
bounded by `maxSteps` (200), so this truncates in practice, and a silent one
would read as a run that did less than it did.

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

## Credentials: what a command is HANDED

`core/src/credentials.ts` is the question standing next to the sandbox's. The
sandbox decides where an allowed command may reach; this decides what it is
given before it runs. `bash` spawned with the agent process's environment, and
that environment holds the keys the user gave to **Arterm** — `ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, and `ARTERM_SECRET`, which unlocks the keystore holding the
rest. One `env` put all of them in the transcript: sent to the provider next
turn, written to the session JSONL, quoted into fleet workers' prompts, folded
into every later compaction. No egress rule sees that path — it leaves through
our own request to the model — and the model need not intend it, since `npm
install` runs package scripts with the same inherited environment.

Three properties make it the opposite shape to the sandbox:

- **On by default, in every mode.** The sandbox is off for attended sessions
  because the prompt is the control there. A prompt does not help here: the
  answer "yes, run `pnpm test`" is not consent to hand `pnpm test` an API key.
- **Default-closed even unwired.** `scrubEnv(env)` with no settings scrubs. A
  `ToolContext` assembled without this plumbing (a sub-agent, a test, a
  standalone call) must not be the one path that still hands the keys over.
- **Names, never values.** A variable is judged by what it is called.
  Value-sniffing ("this looks like a token") eventually eats a `PATH` entry, and
  a control that breaks the toolchain is one people switch off — the same
  argument that makes the sandbox confine writes rather than forbid reads.
  `SSH_AUTH_SOCK` and `XDG_SESSION_*` are deliberately NOT matched for exactly
  this reason; they are the false positives that would have sunk the feature.

`extendEnv: false` is load-bearing in `bash.ts`. execa MERGES `env` into
`process.env` by default, so passing a scrubbed map alone would have handed the
originals through anyway — and that same default is why the **sandboxed** path
leaked too, the wrapper's `env` being additive rather than the whole environment.

The **verify command** gets the same treatment, and is the sharper case:
`makeCommandVerifier` spawns it directly rather than through the sandbox, and
`extractVerifyCommand` means it can come from MODEL OUTPUT. Its stdout is
ignored, so nothing reaches the transcript — what a full environment would still
buy is an outbound `curl` carrying the session's keys, from the one command that
never crosses the boundary. `spawn` inherits `process.env` when `env` is omitted,
so this has to be passed explicitly; omitting the settings still scrubs.

**The same secret is also on DISK, and a scrub cannot reach it.** `env` is one
door; `cat ~/.arterm/key ~/.arterm/secrets.json` is the other, and it yields
*more* than the environment holds — every key `arterm auth set` stored was never
there for the scrub to withhold. So the boundary is closed at both layers, and
each covers what the other cannot:

- **`resolveSandbox` seeds `denyRead` with `keystorePaths()`** — a FLOOR, not a
  default. `allowedDomains: []` is a thing a user can intend; "let the agent read
  my own API keys" is not, and unlike every other entry there the denial costs no
  toolchain anything. It is the two FILES, never `ARTERM_HOME`: spooled tool
  output lives under the same directory and the model is deliberately sent back
  for it. The list is derived from `keystore.ts` rather than re-spelled, because
  a denial that matches nothing fails silently.
- **`OWN_KEYSTORE_READ` in the arbiter grades a command that names them
  `critical`** — the one place that grade means "no legitimate call exists"
  rather than "readable and destructive". `high` would be a question with one
  answer, and under `--autonomous` it would not even be asked: yolo returns
  `allow` on an escalation, and only `critical` blocks. This half matters because
  the sandbox is OFF by default for attended sessions.
  `THIRD_PARTY_CREDENTIAL_READ` (`~/.ssh/id_*`, `~/.aws/credentials`, `~/.netrc`,
  `~/.npmrc`, …) is `high` instead, because `ssh-add` is a real thing to ask for
  — with the stated cost that yolo therefore allows it.

`scripts/keystore-denyread-e2e.mjs` is what makes the mechanism half a fact
rather than a claim: a unit test proves the LIST, and the door is only shut if
bubblewrap acts on it. Against the pre-fix build it scores **1/5**, with the
sentinel key printed by all four reads — two of which (`cat $HOME/*`, `grep -r`)
never name the file, which is precisely the gap a text screen cannot close. Its
fifth check is that the spool is still readable, since denying the directory
would have been the easy wrong fix.

`withheldNote` takes the command and its output as evidence and reports only
names they actually mention. Unconditional, it would append a credentials line
to every failing command in any session that has a key set — pointing the model
at the wrong cause of a failure that had nothing to do with it. Conditional, it
fires on the case it was written for: tools that need a variable name it.

## Attachments: the one path where a path is NOT confined

`core/src/attachments.ts` turns a file the **user** named into `Message.images`.
It exists because that field promised "a picture the user pasted" from the day
it was written and nothing ever populated it: every image a model saw came from
a tool result, so it could look at a screenshot it took and not at one you have.

Its boundary is the deliberate **inverse** of `resolveWithin`'s, which is why it
is its own file rather than a helper inside `read`. A tool's `path` argument is
model output, so it is confined to the working directory — that is the
CVE-2025-59532 lesson and it does not bend. A path typed into the composer is
not model output: a human named a file on their own machine and pressed Enter,
and confining that would refuse the ordinary case (a screenshot in `~/Pictures`)
while protecting nobody. What keeps the exception honest is structural, not a
comment: **nothing in the tool layer may call these functions.** They are
reached from the composer's submit path, and from nowhere else.

Everything that is *not* about location still applies, and one of those carries
the weight the path check gave up: the **magic number**. It is what stops
"attach my private key" from being something this can do at all, quite apart
from its first job of keeping an HTML error page named `.png` out of a provider
400. The size ceiling is derived from the loop's base64 cap rather than chosen,
so the size reported is the file's own.

A refusal always NAMES the file. Silence there reads as "the model is looking at
it", which is the single wrong belief this must not leave a user holding — the
same rule as `acceptImages`, whose cap the user's images are then held to as
well, because the provider that would reject them does not care who chose them.

**A pasted image needs a REPRESENTATION in the line**, because a terminal has
no pixels to give it. `imagePlaceholder` puts `[Image #1]` where the prompt can
show it, place it in the sentence, and — the part that matters — delete it:
`stillMentioned` keeps only the held images whose token survived to the
submitted line, so the TEXT is the truth and the held list follows it. One
Backspace removes the whole token (`editing.ts`), since it is the one atom the
user did not type character by character, and a half-eaten `[Image #` matches
nothing while the image stays attached. The token stays in what goes to the
model: it is not the user's own words, but it says where the image belongs, and
with several attached it is the only way to write "compare [Image #1] with
[Image #2]".

`ARTERM_CLIPBOARD_CMD` points at an executable that writes image bytes to
stdout — a PATH, not a command string, because a quoting bug here would read as
"no image on the clipboard" rather than as the mistake it is.

**A terminal does not deliver a dropped picture — it types the PATH.** So the
drag arrives as text and `extractImagePaths` has to read the submitted line;
quoted, backslash-escaped and `file://` forms come first because splitting on
whitespace tears `my shot.png` in half. The path is *not* stripped from the
text: the user typed it, it names what they are asking about, and silently
editing someone's own sentence is worse than a duplicated path. Ctrl+V is the
other half (`readClipboardImage`, over wl-paste/xclip/pngpaste — OSC 52 has a
copy but no read). Every reader is tried rather than one chosen from
`$WAYLAND_DISPLAY`, because the environment answers which display server runs,
not which helper is installed.

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

## The chronicle: what a run DID, apart from what it said

`core/src/chronicle.ts` is the MAPPING (the envelope, the hash chain, which seam
becomes which record); `cli/src/chronicleStore.ts` is the MECHANISM (one JSONL
file per session under `$ARTERM_HOME/chronicle/`). Same split as telemetry and
the sandbox, for the same reason.

It exists because of the hole the verify section admits: the judge "only reads
the result. It never sees the diff." Two runs proved the cost — a fleet worker
rewrote `slug()`, committed it as `docs(…)`, and the judge passed it saying the
behavior was untouched; and an autonomous run that fixed two real bugs reported
a mechanism for one of them that had never happened. In both, the run's own
narration was the only account of the run.

**So the ledger records the seam, not the story.** `ToolResult.path` and `.diff`
come from the TOOL — and `diff` is explicitly never sent to the model — while
`contentHashAfter` is read back off the disk. None of the three can be written
by a model composing a summary. `mutatingDiff.test.ts` already forces every
writing tool to declare both, so coverage is inherited rather than re-argued.

The chain is WrongStack's: `previousHash` anchored at `GENESIS_HASH`, each
record's `hash` excluded from its own preimage, one `stableStringify` shared by
every reader. That encoder is part of the durable format — two subtly different
ones produce a "tampered" verdict on a file nobody touched. Deletion is the case
that motivates the chain at all: a removed record leaves every survivor hashing
correctly, so only the link between them can tell.

Registered `before("permission")`, NOT `before("execute")` where the telemetry
span goes, because a denied call never reaches `execute` and a denial is exactly
what a summary drops. The price is that `durationMs` spans the decision too, so
it is not the latency number — `gen_ai.*` still owns that.

**It never fails a run.** `Chronicle.append` swallows a throwing sink and still
advances the chain: a record that failed to PERSIST is not a record that was
tampered with, and letting the sequence skip would make a full disk look like an
edited ledger. Telemetry's policy, the sandbox's opposite — this observes, it
does not control.

**Sub-agents write to the PARENT's chronicle**, because the workers are where
the writing happens — a ledger that recorded the leader and not the fleet would
describe the one agent that mostly reads. They get a container carrying only the
ledger stage, never the parent's: sharing that would hand a worker the parent's
`execute` stage, which closes over the parent's tools and cwd, and the Agent's
`has(name)` guard means it would silently keep it instead of building its own.

One instance, so a fan-out is one chain — three workers interleaving into three
chains could each verify while the run as a whole had no order at all. Each
record is stamped with `agentId`, filled from `FleetTask.id` or, for an
anonymous parallel slot, `role#index`. Without it a three-worker round records
three writes by "implementer" and cannot say which made which, which is the
question a fan-out exists to make hard.

**The judge reads the ledger against the claim.** `VerifyRequest.evidence`
carries a per-file block — path, ±counts, digest, which worker — and
`buildJudgeInstruction` renders it AFTER the claim, so the two are read against
each other. The instruction says what a disagreement means, because evidence
nobody is told how to use is decoration: a file the claim never mentions, one it
says it changed that is absent, or a change credited to the wrong worker IS the
"concrete evidence" the prompt already demanded before any rejection. A record
that merely says less than the claim is not — it covers file writes and nothing
else.

The asymmetry does not move. The judge still decides and still fails open; what
changed is that it now has something to decide WITH. Seen working on a real run
told not to touch `slug.ts`: the verdict came back *"The record shows only
README.md +38/-0, confirming slug.ts was not modified, as claimed"* — the same
question the documented failure got wrong by assuming.

`evidenceBlock` returns nothing when the run wrote nothing, rather than an empty
section: "what was recorded: (nothing)" reads as "nothing happened", which is
false for a review or a question. Truncation at `MAX_EVIDENCE_FILES` is stated,
the same rule `roundClaim` follows.

`arterm chronicle verify` exits 1 on a broken chain, so a script can gate on it.
Still absent: a watcher that would tell a change the agent made from one that
appeared underneath it. `bash` declares no path, so a file written by a shell
command is invisible here — the same documented hole checkpoints have. Nothing
prunes `$ARTERM_HOME/chronicle` yet.

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

**`--max-duration` is what keeps a timeout from erasing the work — `--max-steps`
is not, and this section used to claim it was.** The reasoning was that
`autoExtend` buys steps while anything is happening, so a pinned `--max-steps`
being absolute would make the run stop and report instead of being killed
mid-work. It does not follow, and the first real trial disproved it: 200 steps
were pinned, the cap never bound because the constraint was the CLOCK, the 900s
task budget expired, and `arterm-result.json` came back 0 bytes. Step duration
varies by orders of magnitude across models and tasks, so a step cap chosen to
approximate a time limit is a guess that is wrong for the next model.

Two mechanisms replace that claim, and a sweep wants both. `--max-duration`
(config `budget.runSeconds`) makes the run stop ITSELF while it can still
report — set it under the task's `[agent] timeout_sec` with a turn's margin,
since the ceiling is checked at the request boundary and a tool call in flight
finishes first. Past `budget.softRatio` the model is told it is in a reserve
phase: stop starting work, bring the change to a consistent state, report. And
`runHeadlessGoal` emits its document on SIGTERM for when something kills us
anyway (`scripts/sigterm-report-e2e.mjs`). 79% of LH-TB failures are timeouts —
verified, arXiv:2607.08964 §3.4, 518/660 — so this is the failure mode, not an
edge of it. Worth knowing before over-investing: those timed-out runs average
only 0.10–0.35 reward, so a rescued timeout is a rescued REPORT, not usually a
rescued task.

**The container is the boundary, so the adapter passes `--no-sandbox`.** Nesting
our bubblewrap inside Harbor's container buys nothing and hard-fails wherever
nested user namespaces are refused. Both that and the task's network policy go
into `harness.json`, because a number without its harness is not comparable to
anyone else's, or to our own from last week. Harness-Bench ran 6 harnesses over
a shared model pool and same tasks and got **52.4% to 76.2%, a 23.8pp spread**
(arXiv:2605.27922); an ablation on TB2 credits **+7.3pp** to harness structure
alone (arXiv:2604.25850, memory +5.6, tools +3.3, middleware +2.2, and system
prompt **−2.3** — the one regression).

Two earlier figures here, "46% vs 80% across scaffolds" and "8–21 pass@1
points", could not be traced to any primary source and have been replaced by the
two above. They also overstated the case: ALE-Claw fixed the model and varied
the harness for a 6.0pp spread against 18.0pp the other way, concluding the
model accounts for ~3× the harness, and found that STRIPPING a harness down
raised mean score while cutting 44% of input tokens. A harness matters; it does
not matter more than the model, and more harness is not better harness.

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

### The arbiter grades unreadability, not just danger

`CRITICAL_BASH` and `HIGH_BASH` are deny-lists, and a deny-list fails **open** by
construction: what it does not recognize it grades `medium`, and `medium` runs
with no prompt under `auto` and `yolo`. `echo cm0gLXJmIC8K | base64 -d | sh` is
`rm -rf /` that no pattern in either list can ever match, because the string the
shell executes does not exist until after the pipe.

`OPAQUE_BASH` is the fail-closed half. It does not try to guess the hidden
payload — it matches the **hiding** (decode-then-execute, `eval` of a
substitution, an interpreter handed a base64 blob, `-EncodedCommand`) and grades
it `high`, which is the closed answer: attended gets a prompt, and every
unattended asker — `subagentPolicy`'s and the `PermissionBroker`'s default —
answers an escalation with "deny". `high` and not `critical` on purpose:
`eval "$(direnv hook zsh)"` is a real thing developers run, so a prompt is the
honest handling of "unreadable" while a block belongs to "readable and
destructive".

The documented hole is hiding **split across calls** — `curl … > /tmp/x` in one,
`sh /tmp/x` in the next. Each half reads as ordinary alone, the two can sit turns
apart, and a rule wide enough to catch them fires on `wget deps.tar && python3
setup.py`. What bounds that case is the sandbox's egress allowlist, not a regex.
