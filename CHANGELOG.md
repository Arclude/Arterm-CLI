# Changelog

All notable changes to **arterm-cli** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] — 2026-07-11

### Added

- **Agent teams (`/team <task>`).** A new autonomy mode where the leader assembles a
  named team of specialist members and assigns work per round: roster (from your
  agent definitions, or ad-hoc) → parallel rounds with per-member git-worktree
  isolation for write-capable members → integration → reflect/repeat. A live member
  board in the TUI shows each member's state, current assignment, and last tool
  activity; `/pause /resume /stop` and plain-text steering work as with `/goal`.
  Also reachable as `/autonomy team <goal>`, and configurable via the new
  `config.team` block (`fanout`, `maxRounds`, `isolation`, `mergeStrategy`, `suggest`).
- **Agent definition files (`/agents`).** Define reusable specialist sub-agents as
  markdown: `<project>/.arterm/agents/*.md` and `~/.arterm/agents/*.md` (project wins
  on name collisions). Frontmatter `name` / `description` / `tools` (allowlist), body
  = the member's system prompt. Definitions also extend the role set used by the
  parallel/phased autonomy modes and `/sdd`, and reload live via `/plugins reload`.
- **Team auto-suggestion.** A large-looking prompt (multiple enumerated items or
  chained scopes) gets a one-line y/N offer to run as a team instead — never a
  silent switch. Disable with `config.team.suggest = false`.
- **Patch auto-apply (`mergeStrategy`).** Worktree patches from team members are
  applied back onto the main tree with `git apply --3way` (team default). A conflict
  marks the member failed and keeps its `arterm/fleet/*` branch for manual recovery;
  `"surface"` keeps the old report-only behavior. The previously dormant
  `config.fleet.mergeStrategy` is now honored for plain fleet runs too.
- **Member observability.** Team members bridge whitelisted events (tool calls,
  messages — never token deltas) off their private bus with a stable member id;
  the HQ dashboard gained a Team panel driven by the same id-keyed events.

### Removed

- **The HQ web dashboard.** The multi-agent aggregator, WebSocket reporter, the
  Next.js web app, the `arterm hq` subcommand, the `--hq`/`--hq-port`/`--hq-connect`
  flags, the `/web`·`/hq` TUI commands, and the `config.hq` block are gone (a
  leftover `hq` block in an existing config file is ignored harmlessly). Live
  multi-agent visibility now lives in the TUI itself (the /team member board).

### Fixed

- **Spurious "host not reachable" warning at startup.** The openai-compat
  preflight probe now carries the stored API key and the configured custom
  headers, so gateways that gate on them (e.g. agentrouter) no longer make a
  perfectly working setup warn on every launch.
- **Sub-agents now inherit MCP/plugin/memory tools.** `spawn`, `spawn_parallel`,
  parallel/phased autonomy workers, and `/sdd` tasks previously ran with only the
  built-in tool set; they now read the live tool roster at spawn time (delegation
  tools still excluded — depth stays one level).

## [0.2.0] — 2026-07-05

A large feature release: subscription login, a multi-agent web dashboard, richer
tooling for small models, a persistent-memory engine, and a Windows-hardening pass.
Backward compatible with 0.1.x configs.

### Added

- **Subscription (OAuth) login for Claude.** Sign in with a Claude Pro/Max account
  instead of an API key: `arterm login [provider]` / `arterm logout [provider]`,
  PKCE flow, encrypted token store with automatic refresh. The TUI login overlay
  gained an inline OAuth step (open browser → paste the `code#state`).
- **HQ monitoring dashboard.** A multi-agent web UI to watch and control live
  sessions: `/web` (alias `/hq`) in the TUI or `--hq` at startup spins up a shared
  aggregator (auto-picks a free port) and reports the session to it; other sessions
  attach with `--hq-connect <url>`. Pause/resume/stop/steer/set-goal from the browser.
  Built as a static Next.js app served by the aggregator. Headless `--print` runs can
  also report with `--hq`.
- **`@arterm/memory` engine (opt-in).** A richer claude-mem-style persistent memory
  (structured observations, progressive-disclosure legend, SQLite/FTS5, semantic
  search). Enable with `config.memory.engine = "cmem"`; the legacy memory stays the
  default. Project memory is scoped to the git repo root.
- **More tools for small models.** `web_search` (keyless), `git` / `git_commit`,
  `test` / `lint` / `format` (package-manager auto-detected), `search` (BM25 code
  search), `symbols` (symbol-level code index), and the `tool_search` / `batch`
  meta-tools so weaker models stop hallucinating tool names.
- **Worktree isolation for the fleet.** Parallel/phased autonomy and `spawn_parallel`
  workers can each run in their own git worktree (`config.fleet.isolation`).
- **Spec-Driven Development.** `/sdd <brief>` runs an interactive interview → spec →
  task-graph → DAG execution, with a live kanban board and phased coordinator.
- **models.dev catalog** lookups for real context windows, pricing, and native-tool
  capability; `arterm models` is enriched, and a `/cost` command shows token usage
  and estimated spend.
- **Headless / scripting mode:** `--print <prompt>` (and piped stdin) run one turn
  without the TUI; `--json` emits `{response, usage, toolCalls}`.
- **Session resume:** `--resume <id>` / `--continue` plus `arterm sessions`.
- **Setup & config UX:** `arterm init` wizard, `/config` editor, login overlay,
  markdown-rendered assistant output, a startup banner, and rich line-numbered edit
  diffs with a per-turn “N files changed” summary.

### Changed

- **Auto permission mode is now “smart”:** safe shell commands screened by the risk
  arbiter run without a prompt, while critical/destructive commands are still gated.
- The context gauge and auto-compaction now use each model's real context window from
  the catalog instead of a fixed 8k.
- The single-agent inline dashboard was replaced by the aggregator + web app as the
  one dashboard.
- CI added (GitHub Actions); line endings normalized to LF.

### Fixed

- **Windows command screening gap:** the arbiter and `bash` deny-list now cover
  Windows-native destructive commands (`rd /s`, `del`, `format`, `reg delete`, …),
  closing a hole in smart-auto mode.
- `bash` process tree-kill on Windows (a hang on cancellation).
- OAuth login URL on Windows opened via `rundll32` so `&` in the URL isn't truncated.
- Memory digest falls back to the main model when `summarizeModel` is invalid.
- Provider requests retry transient failures; config is validated (zod + deep-merge)
  and warns on malformed JSON instead of silently resetting.
- Mouse-wheel scroll direction in the transcript; assorted TUI status-bar spacing.

### Security / robustness

- `EventBus.emit()` isolates each listener in try/catch so one bad subscriber can't
  crash a turn.
- Global `unhandledRejection` / `uncaughtException` handlers; `agent.assess()` /
  `agent.plan()` guarded against provider errors; `agent.run()` turn teardown no
  longer leaks on pre-loop I/O failures.
- Ollama embedder fetch has a 10s timeout.
- Headless mode is fail-closed: tools needing a permission prompt are denied unless
  `--yolo` / an auto mode is set.

## [0.1.2] — 2026-06-26

- Correctness and robustness fixes from a full-codebase audit (stream timeout, symlink
  confinement, Ollama tool handling, search cache, context gauge).
- Provider-aware startup preflight.

## [0.1.1] — 2026-06-25

- Ran the agent loop on the DI kernel (Container / RunController / Pipeline migration,
  D1–D6).

## [0.1.0] — 2026-06-24

- First npm-ready release: WrongStack-parity safety (risk tiers, yolo fail-closed),
  parallel autonomy, the DI kernel, responsive status bar, edit diffs + `multi_edit`,
  persistent project memory, a memory viewer web UI, and an `arterm mcp` stdio server.

[0.2.0]: https://github.com/Arclude/Arterm-CLI/releases/tag/v0.2.0
[0.1.2]: https://github.com/Arclude/Arterm-CLI/releases/tag/v0.1.2
[0.1.1]: https://github.com/Arclude/Arterm-CLI/releases/tag/v0.1.1
[0.1.0]: https://github.com/Arclude/Arterm-CLI/releases/tag/v0.1.0
