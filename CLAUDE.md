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
