# Changelog

All notable changes to **arterm-cli** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] — 2026-08-05

### Added

- **Result verification, on by default.** Every mode's completion claim now
  passes one gate (`gateClaim()`): a deterministic command check that **fails
  closed** — an exit code is not an opinion — with an LLM judge behind it that
  **fails open**, so an unreachable judge can never turn finished work into a
  rejection. The verdict is data, never prose: the judge reports via a
  `submit_verdict` tool call read off its private bus, and only
  `pass === false` blocks. A task can declare its own gate with a
  `verify: <cmd>` line; `verify.command` / `--verify-cmd` is the **standing
  gate** that runs when the work declares nothing — it comes from config or
  argv, never from the model, so a worker can narrow the gate but never widen
  or remove it. A rejection queues its `mustFix` items as steers into every
  mode's next prompt; `--persist` keeps working past the rejection cap, up to
  the mode's own step bound.
- **Unattended runs: `--autonomous`.** One flag flips the five switches a
  walk-away run needs — yolo permissions, verify-persist, sub-agent
  auto-approve (workers get a fail-closed policy whose asker answers "deny"
  instead of hanging on a prompt no one will answer), progress-gated step
  extension, and the loop detector — and announces itself on stderr. It warns
  when no standing gate exists (the judge only reads the result — it cannot
  catch work that contradicts the goal), and the loop detector is the one
  switch that overrides an explicit `loopDetect.enabled: false`, with its own
  warning: persist plus auto-extend without the detector runs unbounded.
- **Loop detector.** Fingerprints each iteration (tool names + first call's
  args) and a sliding window of individual calls, so verbatim repetition and
  A-B-A-B alternation are both caught: a corrective steer note at 3 repeats, a
  turn cut at 5 — for the main agent and sub-agents alike, with
  `loop_detected`/`loop_cut` bridged to the parent board.
- **Progress-gated step cap.** `autonomy.autoExtend` grants more steps at the
  cap only if tool calls or verification attempts happened since the last
  grant; an explicit `--max-steps` is absolute (`hardCap`) and bounds eternal
  too, which is what makes eternal runs testable in CI. Eternal itself gains
  continuation mechanics: a journal of classified steps prepended to each
  directive, a pivot to ONE different task after `failureBudget` consecutive
  non-ok steps, abort-aware 2s→60s backoff on retryable provider errors, and
  a stop after two exhausted budgets when the provider never once succeeded.
- **Headless goal runs.** `arterm --print --goal "…"` drives any autonomy mode
  without a terminal and streams its verdicts; `--json` adds a structured
  run + verdict list plus a `guards` block (`loopSteers`, `loopCuts`,
  `extensions`) — a run the loop detector killed twice no longer prints
  exactly like a run that had nothing to do.
- **Inspectable permissions + remote approval.** `arterm permissions explain
  <tool>` prints the full rule trace for one proposed call and `arterm
  permissions list` tables every tool — both through the same `evaluate()`
  the runtime uses, so the inspectors cannot drift from the policy. Pending
  permission prompts can be approved remotely through the status server.
- **Provider resilience.** A bounded retry budget with a typed error taxonomy,
  a fallback model chain (`fallbackModels`) that short-circuits refusals to
  the next model, and a rule the Anthropic provider enforces: the vendor SDK
  never owns the retry loop, so an hour-long `Retry-After` can no longer
  become an hour-long sleep the fallback chain cannot see. Exercised by a
  fault-injection e2e (`scripts/provider-resilience-e2e.mjs`) and a manual
  fault server (`scripts/fault-server.mjs`).
- **Concurrent sessions.** Multiple sessions in one TUI with a session panel,
  Ctrl+X close, and recorded sessions resumable via `--resume <id>` /
  `--continue`.
- **/sdd workers get their context.** Each task's prompt now carries the spec
  its graph was cut from and the quoted output of every finished dependency —
  the only channel between waves — with a scope sentence that keeps a worker
  on its own task. The kanban is navigable, runs are keyed by their own task
  ids, and stranded work is surfaced instead of hidden.

### Fixed

- A turn now actually finishes when its work does, and sub-agents inherit the
  parent's token/context limits instead of running uncapped.
- Free-text slash commands no longer flatten what was typed after them.
- Mouse capture modes are re-asserted on resize, healing host-emulator resets.

## [0.3.3] — 2026-07-12

### Added

- **Fullscreen mode (default).** The TUI now owns the whole window on the
  alternate screen, like Claude Code's fullscreen renderer: the input and
  status bar stay pinned to the bottom **even while scrolling**, and the wheel
  scrolls the chat in-app (SGR mouse capture — direction is encoded in the
  bytes; text selection uses the terminal's Shift+drag bypass). PgUp/PgDn page;
  ↑ still recalls prompt history; a hint row shows how far back you are.
  `tui.fullscreen: false` restores the classic native-scrollback mode, and
  `tui.mouse: false` swaps capture for alternate-scroll arrows (plain
  drag-select, terminal-dependent wheel direction).
- **Type while the model works + message queue.** The prompt stays live during
  a turn; Enter queues each message (dimmed ⏳ lines above the input) and the
  queue dispatches FIFO as the loop returns to idle. Esc cancels the turn and
  drops the queue; `/clear` empties it too.
- **`/copy`** copies the last assistant reply to the clipboard via OSC 52.
- **Degenerate tool-call recovery.** Small local models that emit
  `{"<tool>": {…}}` (no name/arguments wrapper) are now recovered — gated on
  real tool names so ordinary JSON in prose can never be mistaken for a call.

### Fixed

- **Flicker-free rendering.** All of Ink's repaint writes are coalesced into
  single frames wrapped in DEC 2026 synchronized output (skipped under tmux),
  and the worst-case full clear can no longer wipe the terminal's scrollback.
- **Fullscreen scrollback actually scrolls.** The old margin-based viewport
  never revealed older rows (it only shrank the visible slice — reading as an
  inverted wheel); the new cutter-window viewport gives line-precise
  scrollback, verified by content-level tests.
- **Footer stays glued to the bottom** in classic mode (AnchoredRegion: the
  dynamic region's height never shrinks mid-flight, so Ink's top-anchored
  repaints can't strand it) — including across resizes.
- **Expired OAuth sessions recover cleanly.** A dead refresh token
  (invalid_grant) is dropped and reported as one actionable line instead of a
  raw 400 dump on every turn.
- Wheel scroll direction restored (wheel up = older lines); typing no longer
  garbles around fast submits (input handlers read state through refs).

## [0.3.2] — 2026-07-11

### Added

- **Team board navigation.** ↑/↓ on an empty prompt select a member on the
  /team board (❯ marker), Enter drills into the selected member's live
  activity feed (tool calls, results, messages — last 100 lines per member),
  Esc closes it. Works during the run and after it finishes.

### Fixed

- **Sub-agent failures are no longer silent.** A sub-agent whose provider
  call failed (e.g. a 401/quota error) used to report "(sub-agent produced
  no output)" while the real reason stayed invisible on its private bus; the
  error now comes back as the sub-agent's result and the member/worker is
  marked failed on the board and in the round summary.

## [0.3.1] — 2026-07-11

### Performance

- **Startup is ~2× faster** (≈2.2s → ≈1.1s to the TUI; `--version` and headless
  bootstrap dropped from ~1s to ~130ms):
  - The OpenAI-compatible host reachability probe no longer blocks startup — it
    runs in the background after the session is up (a WAN round-trip to a relay
    cost ~1s on every launch) and surfaces as an in-TUI warning if it fails.
  - Heavy dependencies load lazily on first use instead of at startup: `execa`
    (shell/git/project tools), `fast-glob` (glob/grep), the MCP SDK server
    modules (`arterm mcp`), and the Ink/yoga rendering stack — the published
    bundle is now code-split so non-TUI commands never load the UI at all.

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
