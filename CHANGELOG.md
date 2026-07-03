# Changelog

All notable changes to **arterm-cli** are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[SemVer](https://semver.org).

## [Unreleased]

### Added

- GitHub Actions CI: build, typecheck, test, lint on Linux + Windows, plus an
  npm-pack smoke install that verifies the published tarball is self-contained.
- Retry with exponential backoff for transient provider errors (HTTP 429/5xx
  and network failures) in the Ollama and OpenAI-compatible providers.
- Stream idle-timeout guard for the `llamacpp` provider (parity with the HTTP
  providers).
- Config validation: `~/.arterm/config.json` is now schema-checked on load;
  invalid values warn and fall back to defaults instead of misbehaving later.
- Nested config blocks (`session`, `context`, `memory`, `autonomy`, `sdd`,
  `fleet`) are deep-merged with defaults, so setting one field no longer wipes
  the rest of the block.
- `arterm init` — interactive first-run setup (provider, model, permission
  mode).
- `/config` TUI command — shows the resolved configuration and where it comes
  from.
- Markdown rendering in the TUI transcript (headings, bold/italic, inline code,
  fenced code blocks) with basic syntax-aware coloring.
- Tests: `bash` tool (deny-list, timeout, cancellation), headless end-to-end
  run against a scripted provider, TUI markdown renderer.

### Fixed

- `bash` tool: timeout/cancel now kills the whole process **tree**. Previously
  only the shell was killed, and (notably on Windows) an orphaned grandchild
  holding the output pipe could hang the agent loop forever despite the
  timeout.

### Changed

- Session persistence now defaults to **on** (`session.mode: "jsonl"`), so
  `--resume` / `--continue` work out of the box. Set `session.mode: "off"` to
  restore the old behavior.
- README rewritten to match the shipped feature set (hosted providers + OAuth
  login, autonomy/SDD, memory, HQ dashboard, headless mode) and to state
  accurately that `bash` is permission-gated but **not** path-sandboxed.

## [0.1.2] - 2026-07-01

- Multi-agent HQ dashboard (`--hq`, `/web`) with auto port selection.
- Memory summarize-model fallback; TUI mouse-wheel scroll direction fix.

## [0.1.1] - 2026-06-28

- Subscription OAuth login (`arterm login`), encrypted API-key store
  (`arterm auth`), models.dev catalog integration, symbol index + `symbols`
  tool.

## [0.1.0] - 2026-06-24

- Initial public release: Ink TUI, Ollama / llama.cpp / OpenAI-compatible +
  hosted providers, permission modes, autonomy engine, SDD fleets, persistent
  memory, headless mode, session resume.
