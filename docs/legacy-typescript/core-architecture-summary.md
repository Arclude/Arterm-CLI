# `@arterm/core` — Architecture Map

A focused explorer's summary of the `@arterm/core` package (`packages/core`), the
foundation every other Arterm-CLI workspace package depends on. `core` **defines
the interfaces** (`ChatProvider`, `Tool`, `Message`, …); `providers`, `tools`,
`tui`, and `cli` implement/consume them. Dependency direction is strictly one-way
(everything → `core`).

`packages/core/src/index.ts` is the barrel: it re-exports types, the event bus,
config, permissions, tool protocol, the agent, and the whole `kernel/`.

---

## 1. Main exported types & interfaces (`src/types.ts`)

The shared vocabulary the rest of the monorepo builds on:

- **`Message`** — `{ role: "system"|"user"|"assistant"|"tool", content, toolCalls?,
  toolCallId?, name? }`. Assistant messages carry `toolCalls`; `tool` messages
  carry `toolCallId` (correlating a result to its call) and the tool `name`.
- **`ToolCall`** — `{ id, name, arguments }` (arguments already JSON-decoded).
- **`ChatProvider`** — the unified streaming backend interface:
  - `readonly id`
  - `supportsNativeTools(model): boolean | Promise<boolean>`
  - `listModels(): Promise<ModelInfo[]>`
  - `chat(req: ChatRequest): AsyncIterable<ChatChunk>`
  - **`ChatChunk`** is a union: `{type:"text",delta}` | `{type:"tool_call",call}` |
    `{type:"done",usage?}`.
- **`Tool`** — `name`, `description`, `parameters` (JSON Schema),
  `permission` (`allow|ask|deny`), optional `category` (`read|edit|execute`),
  `mutating?`, `riskTier?` (`safe|caution|destructive`), optional `preview(args)`,
  and `execute(args, ctx: ToolContext): Promise<ToolResult>`.
  - **`ToolContext`** = `{ cwd, signal?, tools? }` (the roster is injected so
    meta-tools like `batch`/`tool_search` can dispatch).
  - **`ToolResult`** = `{ output, isError?, diff?, path? }` (`diff`/`path` are
    TUI-only metadata, never sent to the model).
- **`ToolSchema`** — the JSON-Schema shape sent to native function-calling models.
- Permission plumbing types: `PermissionLevel`, `PermissionAnswer`
  (`allow|allow_always|deny`), `PermissionAsker` (the host callback that pops the
  prompt). Plus many higher-level surface types (autonomy, team, SDD, MCP,
  plugins, skills) that other subsystems consume.

---

## 2. Event bus (`src/eventBus.ts`)

- **`AgentEvent`** — a large discriminated union covering the whole loop
  lifecycle: `turn_start`, `text_delta`, `assistant_message`, `tool_call`,
  `tool_result`, `tool_denied`, `permission_request`/`permission_resolved`,
  `usage`, `context_compacted`, `tool_results_cleared`, `run_limit`, `turn_end`,
  `error`, plus autonomy / fleet / phased / team / SDD telemetry.
- **`EventBus`** — a minimal *synchronous* pub/sub. `on(listener)` returns an
  unsubscribe. `emit()` isolates each listener: a throwing subscriber is routed
  to `onListenerError` (silent unless `ARTERM_DEBUG`) and never breaks the emit
  loop or the agent turn. The agent publishes; the TUI/memory recorder subscribe.

---

## 3. Configuration (`src/config.ts`)

- **`ArtermConfig`** — the full session config: `provider`/`model`, host URLs,
  `temperature`, per-tool `permissions`, `mode`, `confirmDestructive`, and nested
  blocks for `session` (transcript logging), `context` (compaction strategy +
  window + thresholds), `budget` (per-turn caps **and** whole-run token/USD
  ceilings), `sandbox` (shell execution boundary), `telemetry` (OTel GenAI
  export), `autonomy`, `loopDetect`, `verify`, `mcpServers`, `plugins`, `team`,
  `fleet`, `arbiter`, `catalog`, `statusServer`, `sdd`, `memory`, and `tui`.
- **`defaultConfig()`** provides all defaults (Ollama at `:11434`, `mode:"ask"`,
  `context.strategy:"window"`, etc.).
- **Loading is defensive**: `loadConfig()` reads `~/.arterm/config.json`, and
  `validateConfigFile()` uses a **partial + passthrough Zod schema**. Invalid
  fields are dropped *per-field* (with a warning) and fall back to defaults
  instead of crashing; `mergeConfig()` deep-merges the user overlay over defaults.

---

## 4. Permissions (`src/permissions.ts`)

- **`PermissionMode`** = `ask | auto | plan | yolo`.
- **`PermissionManager.check(tool, args, ask)`** resolves whether a call runs, in
  a strict, fail-closed order:
  1. Tool-level `deny` wins in **every** mode (even yolo).
  2. The optional **Brain Arbiter** (`ToolArbiter`) runs in every mode: `deny`
     blocks (even yolo), `escalate` forces a human prompt, `allow` approves.
  3. A `riskTier:"destructive"` tool re-prompts when `confirmDestructive` is on.
  4. `yolo` approves the rest without prompting; `plan` blocks anything non-`read`;
     `auto` silently approves `edit` and (only with an arbiter screening) `execute`.
  5. Otherwise it invokes the host `ask` callback; `allow_always` persists an
     override.

---

## 5. Tool protocol / non-native fallback (`src/toolProtocol.ts`)

For models lacking a native function-calling API:

- **`toolSystemPrompt(tools)`** documents the tools and instructs the model to
  emit a fenced ```json block `{"tool":"<name>","args":{…}}`.
- **`parseToolCalls(text, knownTools?)`** recovers calls from assistant text and
  returns the cleaned text. It is deliberately tolerant of small-model quirks:
  fenced *and* bare JSON, arrays of calls, the OpenAI `{name,arguments}` shape,
  and the degenerate `{"<tool>": {…args}}` shape (accepted only when the single
  key is a real tool name). `extractBalancedObjects()` scans balanced braces while
  respecting string literals/escapes.

---

## 6. The kernel (`src/kernel/`) — DI + pipelines + run lifecycle

A tiny DI layer the agent loop runs on. `kernel/index.ts` re-exports tokens,
container, pipeline, runController, bus.

### `Container` (`kernel/container.ts`)
Lazy, memoized, typed DI:
- `bind(tok, factory)` (throws if already bound), `override` (replace + drop
  cached singleton), `decorate` (wrap the resolved value, e.g. to trace),
  `resolve(tok)` (memoized singleton; falls back to parent), `has`, and
  **`createScope()`** — a child that inherits bindings but keeps its own singleton
  cache, so a run can `override` a service without polluting the root.

### Tokens (`kernel/tokens.ts`)
- `token<T>(description)` mints a branded, phantom-typed `Token<T>` whose identity
  is a `Symbol` (no runtime cost).
- **`Tokens`** table: `Logger`, `TokenCounter`, `SessionStore`,
  `PermissionPolicy`, `Compactor`, `Bus`, `Pipelines`, `RunController`.
- `kernel/bus.ts` just aliases `Bus = Tokens.Bus` so the existing `EventBus`
  instance is folded into the kernel namespace by token (not reimplemented).

### `RunController` / `RunHandle` (`kernel/runController.ts`)
Owns the lifecycle of **one turn**:
- `begin()` returns a **`RunHandle`** with: a single `signal` (the one source of
  truth for cancellation — it *wraps* `AbortSignal`, so existing `signal?.aborted`
  checks keep working), a per-run child `scope` container, `onTeardown(fn)`
  disposers run **LIFO** by `finish()` (idempotent, never throws), an
  `iterationLimit`, and a `shouldContinue`/`requestContinue` autonomous-continuation
  flag, plus `abort(reason)`.

### `Pipeline` (`kernel/pipeline.ts`)
- **Koa-style, onion-model middleware**: `Middleware<Ctx> = (ctx, next) => …`.
  Stages are **addressable by name**, so features can `use`/`before`/`replace`/
  `remove`/`has` a stage without rewriting the host. `run(ctx)` composes them
  around a shared mutable context; a stage that omits `next()` short-circuits, and
  calling `next()` twice throws.
- **Six pipelines** (`PipelineRegistry`, built by `createPipelines()` as empty
  pass-throughs), each with its own context type:

  | Pipeline | Ctx | Role in the loop |
  | --- | --- | --- |
  | `userInput` | `{input}` | persist the user message |
  | `request` | `{system,messages,native,refused?}` | gate + assemble the prompt |
  | `response` | `{text,calls,usage?}` | meter + post-process the model reply |
  | `assistantOutput` | `{message}` | record + announce the assistant message |
  | `toolCall` | `{call,signal,tool?,output?,isError?,diff?,path?}` | gate + run one tool |
  | `contextWindow` | `{messages,reason,before?,after?}` | compaction / clearing |

  Two of those fields carry a contract worth knowing. `request.refused` is set by
  a stage that will not let the request be sent (the run budget's hard ceiling):
  short-circuiting alone only skips the remaining stages, so the loop reads this
  field and ends the turn — the same convention `toolCall.permission` uses to
  deny. `response.usage` is present **only** when the backend reported it, so a
  stage that meters spend must treat `undefined` as "unknown", never as zero.

---

## 7. Agent loop architecture (`src/agent.ts`)

**`Agent`** drives the conversation: stream model output → execute tool calls
(gated by permissions) → feed results back until a final answer. The key design
point: **the loop's seams are pipeline stages, not inlined code.** You change loop
behavior by adding/replacing a named stage, never by editing `run()`.

### Composition & construction
- `AgentOptions` carries everything (`provider`, `model`, `tools`, `permissions`,
  `ask`, `bus`, `cwd`, budgets, context strategy, `container?`, …).
- The constructor resolves `RunController` and the `PipelineRegistry` from the
  supplied `container` (the session's root container — see `buildSession` in
  `@arterm/cli`) or a `defaultAgentContainer()` fallback for sub-agents/tests.
- **`installDefaultPipelines()`** registers the built-in stages, each guarded by
  `pipeline.has(name)` so a feature/test that pre-registered the same name wins.
  Order inside a pipeline is registration order, and it is load-bearing:

  | Pipeline | Stages, in order | `*` = conditional |
  | --- | --- | --- |
  | `userInput` | `record` | |
  | `request` | `budgetGate`\* → `buildSystem` | a ceiling is configured |
  | `response` | `budgetMeter` → `recoverToolCalls` → `loopDetector`\* | detector on |
  | `assistantOutput` | `record` | |
  | `toolCall` | `permission` → `execute` → `loopGuard` → `repeatWindow`\* | detector on |
  | `contextWindow` | `clearToolResults` → `autoCompact` | |

  - `request.budgetGate` refuses before `buildSystem` assembles anything, so a
    run at its ceiling spends nothing on a prompt it will not send. Installed
    only when a run ceiling exists (`!budget.inactive`) — with none there is
    nothing to gate on.
  - `response.budgetMeter` records the provider's own usage (never an estimate —
    each iteration resends the history, so estimating double-counts the whole
    conversation per lap). Unlike the gate it is installed whenever a `RunBudget`
    exists, ceiling or not: reporting spend is not conditional on limiting it,
    and gating that on a limit made every unlimited run report zero cost.
  - `toolCall.permission` resolves the tool and gates it via `PermissionManager`,
    short-circuiting on unknown/denied → `execute` calls `tool.execute` with
    `{cwd, signal, tools, sandbox?}` → `loopGuard` appends corrective notes when
    a tool fails repeatedly or an identical call is replayed (a nudge for small
    models) → `repeatWindow` is the loop detector's per-turn half.
  - `response.loopDetector` + `toolCall.repeatWindow` are one detector's two
    halves, created once per agent and installed as a pair — or dropped as a
    pair by `loopDetect: {enabled:false}`. They share a closure, so the
    iteration fingerprint outlives individual turns: repetition ACROSS
    eternal-mode steps is the target, and resetting per turn would miss it.
  - `contextWindow.clearToolResults` replaces stale tool outputs with
    placeholders once usage crosses ~0.6 of the window, then `autoCompact`.
  - `response.recoverToolCalls` is the JSON tool-call fallback (`parseToolCalls`).

- **Stages the composition root adds on top** — `buildSession` in `@arterm/cli`,
  registered *after* the agent is constructed but positioned by name, which is
  the point of naming them:
  - `userInput.checkpointTurn` (appended) and a file-snapshot stage `before`
    `permission`, so a denied call costs no snapshot (see `CheckpointStore`);
  - the optional model gate `before` `permission` (config `arbiter.model`) — it
    can only BLOCK; the regex arbiter and the mode still decide the rest;
  - `telemetry` on `request`/`response` (appended) and `before` `execute` on
    `toolCall`, when OTel export is on.

  These are session wiring rather than loop defaults, but they are what actually
  runs — a chain read from `installDefaultPipelines()` alone is incomplete.

### `run(userInput, signal?)` — one turn
1. Detect `native` tool support; `runController.begin()` opens a `RunHandle`. The
   caller's `signal` is **linked** into the handle (not threaded directly), giving
   cancellation one source of truth. `turn_end` is registered as teardown.
2. `userInput.run` persists the user message (inside `try` so write failures
   surface as `error` events and still tear down).
3. Loop up to the iteration limit; each iteration:
   - `contextWindow.run` (auto-clear / auto-compact),
   - `request.run` (gate, then build the system prompt). If it comes back with
     `refused` set, the turn **breaks here** rather than mid-flight: history
     stays well-formed, nothing is half-paid for, and the turn closes with what
     it already produced,
   - `streamRaw()` calls `provider.chat`, collecting text + native tool calls and
     emitting `text_delta`/`tool_call`/`usage` events,
   - `response.run` (recover JSON tool calls if none came natively),
   - `assistantOutput.run` (record + emit `assistant_message`).
   - If no tool calls → done. Otherwise run each call through `toolCall.run`
     (aborted mid-turn still writes a cancelled tool result so history stays valid
     for native APIs), then check the per-turn **token budget**.
4. Emits `run_limit` when iterations/tokens are exhausted; `finally` runs LIFO
   teardown (`turn_end`).

### Context management
- **`effectiveContextWindow()`** consults the models.dev catalog for the real
  window, falling back to config.
- `shouldClearToolResults()` / `clearStaleToolResults()` replace old tool outputs
  with placeholders (only content changes, so call-pairing survives).
- `shouldAutoCompact()` + `compact()` delegate to the configured `ContextStrategy`
  and emit `context_compacted`; the on-disk transcript is untouched.
- `buildSystem()` assembles the persona + environment prompt (cwd listing,
  project instructions from `AGENTS.md`/`CLAUDE.md`/`ARTERM.md`, skills, plan-mode
  notice, recalled memory) and either injects the JSON tool protocol (non-native)
  or a "these are the only tools" roster (native).
- `assess()` / `plan()` are one-shot, tool-less, history-preserving probes used by
  the autonomy engine.

---

## Mental model

`core` = **interfaces + a composable agent loop**. Providers/tools plug into the
interfaces; the agent loop is assembled from named middleware stages on six
pipelines, wired through a lazy DI container, with each turn's cancellation and
teardown owned by a `RunController`. Extend behavior by adding a stage — not by
editing `run()`.
