# Configuring the System Prompt

arterm builds its system prompt from several layers. Two of them are user-editable
files, so you can tune agent behavior without rebuilding.

## Layers (in order)

1. **Base system prompt** — built-in `crates/arterm-base/src/prompt/system_prompt.md`,
   overridable by file (see below).
2. Capability modules (e.g. Mermaid guidance).
3. Self-dev guidance (self-dev sessions only).
4. `AGENTS.md` — project `./AGENTS.md` (or `./CLAUDE.md` if `AGENTS.md` is missing) and global `~/AGENTS.md`. `/init` generates or updates the project file.
5. Prompt overlay — `./.arterm/prompt-overlay.md` and `~/.arterm/prompt-overlay.md`.
6. Preferred tools — `./.arterm/preferred-tools.md` and `~/.arterm/preferred-tools.md`.
7. Memory and the active skill prompt (dynamic, not cached).

## Adding guidance (most common)

Append instructions without touching the default prompt:

- `~/.arterm/prompt-overlay.md` — applies everywhere.
- `./.arterm/prompt-overlay.md` — applies to one project.

Both are included when present.

## Replacing the base prompt

To fully replace layer 1, create either file:

- `./.arterm/system-prompt.md` (project, highest precedence)
- `~/.arterm/system-prompt.md` (global)

The first non-empty file wins; otherwise the built-in default is used. An empty or
whitespace-only file falls back to the default, so you cannot accidentally ship an
empty prompt.

This replaces only the base prompt. AGENTS.md, overlays, skills, and memory still apply.

## Generating a project briefing

`/init` explores the current working directory and writes or updates `AGENTS.md`.
Later sessions load that file automatically. If a repo already has Claude Code's
`CLAUDE.md` and no `AGENTS.md`, Arterm loads `CLAUDE.md` until `/init` creates
the Arterm-native file.

## Notes

- Changes to these files take effect for **new sessions**; a running session keeps the
  prompt captured at start.
- Editing the built-in `system_prompt.md` requires a rebuild (`selfdev build-reload`),
  since it is embedded with `include_str!`.
- Swarm model-routing guidance has its own analogous file: `.arterm/swarm-prompt.md`.
