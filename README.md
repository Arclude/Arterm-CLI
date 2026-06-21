# Arterm-CLI

A terminal AI coding agent that runs **local** models. Arterm takes a hybrid
approach to model hosting: connect to a running [Ollama](https://ollama.com)
server, or load a `.gguf` file directly in-process via
[`node-llama-cpp`](https://github.com/withcatai/node-llama-cpp) — no API keys, no
cloud. It streams chat into an [Ink](https://github.com/vadimdemedes/ink) TUI and
can read, search, and edit your files and run shell commands through a
permission-gated tool set.

## Features

- **Ink TUI** — an interactive terminal chat with a live status bar (provider,
  model, token count) and slash commands.
- **Streaming chat** — model output is rendered token-by-token; press `Esc` to
  cancel a running turn.
- **File & shell tools** — `read`, `ls`, `glob`, `grep`, `write`, `edit`, and
  `bash`, all scoped to the working directory.
- **Per-tool permission system** — read-only tools auto-allow; tools that mutate
  state or run commands prompt before each call, with an "always allow" that
  persists.
- **Hybrid providers** — talk to Ollama over HTTP, or load a GGUF directly with
  `node-llama-cpp`. Models can be listed across both backends at once.
- **Native + JSON-fallback tool-calling** — uses a backend's native
  function-calling API when the model supports it, and falls back to a
  model-agnostic JSON protocol parsed from the text body when it doesn't.

## Requirements

- **Node** >= 22
- **pnpm** >= 9
- One of (optional, depending on the provider you use):
  - **Ollama** running locally (`ollama serve`), for the `ollama` provider, or
  - a **`.gguf` file** plus `node-llama-cpp`, for the `llamacpp` provider.

## Install & build

```bash
pnpm install
pnpm -r build
```

This builds every package under `packages/`. After building, the CLI entry point
is `packages/cli/dist/main.js`, exposed as the `arterm` bin.

## Usage

Run the built CLI directly:

```bash
node packages/cli/dist/main.js
```

or, once the `arterm` bin is on your `PATH` (e.g. via `pnpm link` or after
publishing):

```bash
# Start the interactive chat TUI (this is the default command)
arterm

# List available models across all configured providers
arterm models

# Download a model via Ollama
arterm pull <model>
```

### Global flags

These apply to every command and override the saved config:

| Flag                       | Description                                  |
| -------------------------- | -------------------------------------------- |
| `-p, --provider <id>`      | Provider to use: `ollama` or `llamacpp`.     |
| `-m, --model <name>`       | Model name (Ollama tag) or `.gguf` filename. |
| `--yolo`                   | Skip all permission prompts.                 |

> When using the `ollama` provider, Ollama must be running. Start it with
> `ollama serve`. If it is unreachable, Arterm prints a warning at startup and
> suggests switching to `--provider llamacpp`.

### TUI slash commands

Inside the chat TUI:

| Command         | Action                          |
| --------------- | ------------------------------- |
| `/help`         | Show the help text.             |
| `/clear`        | Clear the conversation.         |
| `/model <name>` | Switch the active model.        |
| `/models`       | List available models.          |
| `/exit`         | Quit (also `/quit` or `Ctrl+C`).|
| `Esc`           | Cancel the running turn.        |

## Direct GGUF loading (llamacpp)

`node-llama-cpp` is an **optional** dependency and is **not installed by
default** — its native (e.g. CUDA) binaries are very large. The `llamacpp`
provider imports it lazily and surfaces a clear error if it is missing.

To enable direct GGUF loading:

```bash
# Install node-llama-cpp into the workspace (or into packages/providers)
pnpm add -w node-llama-cpp
```

Then drop a model file into `~/.arterm/models/` and select it:

```bash
arterm --provider llamacpp --model <file.gguf>
```

The provider loads the GGUF in-process (no server required). Tool-calling uses
the universal JSON fallback, so it works regardless of the model.

## Architecture

A pnpm + TypeScript (ESM) monorepo. Five packages live under `packages/`, and the
dependency direction is one-way: **everything depends on `core`**, which owns the
shared interfaces.

| Package             | Responsibility                                                                  |
| ------------------- | ------------------------------------------------------------------------------- |
| `@arterm/core`      | Shared types (`ChatProvider`, `Tool`, `Message`), the agent loop, config, event bus, permission manager, and the tool-calling protocol. |
| `@arterm/providers` | Backend implementations: `OllamaProvider` and `LlamaCppProvider`, plus a registry to build/list them. |
| `@arterm/tools`     | The file & shell tools (`read`, `ls`, `glob`, `grep`, `write`, `edit`, `bash`) and their registry. |
| `@arterm/tui`       | The Ink terminal UI: chat view, status bar, permission prompts, slash commands. |
| `@arterm/cli`       | The `arterm` binary: argument parsing (commander), session wiring, and the `chat`/`models`/`pull` commands. |

## Config

Configuration lives in `~/.arterm/` (the `ARTERM_HOME` directory). It is created
on demand; sensible defaults are used when no file is present.

`~/.arterm/config.json` fields:

| Field         | Description                                                       | Default                  |
| ------------- | ----------------------------------------------------------------- | ------------------------ |
| `provider`    | Active provider id (`ollama` or `llamacpp`).                      | `"ollama"`               |
| `model`       | Active model (Ollama tag, or a `.gguf` filename for `llamacpp`).  | `"llama3.2"`             |
| `ollamaHost`  | Base URL of the Ollama server (env `OLLAMA_HOST` overrides).      | `http://127.0.0.1:11434` |
| `modelsDir`   | Directory holding `.gguf` files for direct loading.              | `~/.arterm/models`       |
| `temperature` | Sampling temperature.                                             | `0.7`                    |
| `permissions` | Per-tool permission overrides, persisted by "always allow".      | `{}`                     |

`~/.arterm/models/` holds the `.gguf` files used by the `llamacpp` provider.

## Permissions

Every tool declares a default permission level, resolved at call time in this
order: a session-wide bypass (`--yolo`), then per-tool overrides (config /
"always allow"), then the tool's own default.

- **Read-only tools** (`read`, `ls`, `glob`, `grep`) — auto-allow.
- **Mutating / shell tools** (`write`, `edit`, `bash`) — ask before each call.
- Choosing **"always allow"** at a prompt persists an override to
  `~/.arterm/config.json` so the tool won't ask again.
- **`--yolo`** bypasses all prompts for the session.
- A few obviously destructive `bash` patterns are refused outright, even with
  permission.

## Development

See [CLAUDE.md](./CLAUDE.md) for the contributor/AI guide: monorepo conventions,
key commands, and how to add a tool or a provider.
