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

It runs the built `arterm` against a fake OpenAI-compatible server that drops
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

`arterm --print --goal "…"` runs the loop headlessly and streams its verdicts —
the scriptable way to exercise any of this without a terminal. Add `--json` for a
structured run + verdict list.

`AutonomyEngine.gateClaim()` is the single call site for every mode. A rejection
queues its `mustFix` items into `pendingSteer`, which every mode's prompt builder
already consumes — that is why no mode needs its own repair plumbing. `eternal`
is exempt on purpose: it never makes a completion claim.

**A `/sdd` task reads its dependencies' output, not their titles.** `SddRunner`
builds each worker's prompt from the task *plus* the quoted output of every
dependency that finished (`upstream()` → `handoff()`). This is the only channel
between waves: a wave-2 worker is a fresh sub-agent with no memory of wave 1, and
under `fleet.isolation: "worktree"` it cannot read wave 1's files either. Clipping
keeps both ends of an over-budget output — the conclusion is at the bottom, so a
plain `slice(0, n)` would throw away the part that matters most.

**The judge runs where the worker wrote.** Never in a fresh worktree —
`createWorktree` bases on `HEAD`, i.e. a tree with the change absent, where a
verifier passes trivially. `/sdd` verification is therefore skipped entirely when
`fleet.isolation` is `worktree` and `mergeStrategy` isn't `apply`.

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
