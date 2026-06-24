# Arterm-CLI

A terminal AI coding agent that runs **local** models. Connect to a running
[Ollama](https://ollama.com) server, point it at any **OpenAI-compatible**
endpoint (LM Studio, vLLM, llama.cpp server, …), or load a `.gguf` file directly
in-process via [`node-llama-cpp`](https://github.com/withcatai/node-llama-cpp) —
no cloud, no API keys required. Arterm streams chat into a rich
[Ink](https://github.com/vadimdemedes/ink) TUI and can read, search, and edit
your files and run shell commands through a permission-gated tool set.

```
▌ARTERM v0.1.0  │  ● idle  │  ollama/qwen2.5:7b  │  ctx ██░░░░░░░░ 12%/32k  │  ↑1.2k ↓340
📁 my-project  │  ⎇ main  │  🔧 7 tools  │  ⏱ 15:45:27  │  ASK
Enter send   ? help   Alt+P models   Esc cancel   ^C quit
```

## Features

- **Rich Ink TUI** — colored message blocks, live token-by-token streaming, tool
  rows with timing/size metadata, a per-turn stats line, and a multi-segment
  status bar (provider, model, context gauge, token counts, branch, clock).
- **Interactive model picker** — press **Alt+P** (or `/model`) for an arrow-key
  selectable list of available models with sizes; `?` opens help.
- **File & shell tools** — `read`, `ls`, `glob`, `grep`, `write`, `edit`, and
  `bash`, all sandboxed to the working directory.
- **Permission system** — read-only tools auto-allow; tools that mutate state or
  run commands prompt before each call, with an "always allow" that persists.
  `--yolo` skips prompts.
- **Multiple providers** — Ollama over HTTP, any OpenAI-compatible server, or a
  GGUF loaded directly with `node-llama-cpp`.
- **Native + JSON-fallback tool-calling** — uses a backend's native
  function-calling API when the model supports it, and falls back to a
  model-agnostic JSON protocol parsed from the text when it doesn't.

## Install

Requires **Node.js >= 22**.

```bash
# Global install
npm install -g arterm-cli

# …or run without installing
npx arterm-cli
```

Then start the chat TUI from any project directory:

```bash
arterm
```

You also need a model backend running — the simplest is Ollama:

```bash
# https://ollama.com
ollama serve            # start the server
ollama pull qwen2.5:7b  # a tool-capable model is recommended
arterm --model qwen2.5:7b
```

## Usage

```bash
arterm                       # start the interactive chat TUI (default)
arterm --model qwen2.5:7b    # pick a model for this session
arterm --provider ollama     # pick a provider
arterm --yolo                # skip permission prompts
arterm models                # list models across configured providers
arterm pull <model>          # download a model via Ollama
```

### Global flags

| Flag                  | Description                                            |
| --------------------- | ----------------------------------------------------- |
| `-p, --provider <id>` | Provider: `ollama`, `llamacpp`, `openai-compat`, `anthropic`, or a hosted preset (`openai`, `gemini`, `xai`, `deepseek`, `groq`, `openrouter`, `mistral`). |
| `-m, --model <name>`  | Model name (Ollama tag) or `.gguf` filename.          |
| `--yolo`              | Skip all permission prompts for the session.          |

### Inside the TUI

| Key / command          | Action                                            |
| ---------------------- | ------------------------------------------------- |
| `Enter`                | Send the message.                                 |
| `?`                    | Show help.                                         |
| `Alt+P` / `/model`     | Open the interactive model picker.                |
| `/model <name\|N>`     | Switch model directly (by name or list number).   |
| `/models`              | Open the model picker.                            |
| `/clear`               | Reset the conversation.                           |
| `/exit`                | Quit (also `/quit` or `Ctrl+C`).                  |
| `Esc`                  | Cancel the running turn.                          |

When a tool wants to write, edit, or run a shell command, Arterm shows a
permission prompt: `[y]` allow once · `[a]` always allow this tool · `[n]` deny.

## Providers

| Provider        | Config / flag             | Notes                                                  |
| --------------- | ------------------------- | ------------------------------------------------------ |
| `ollama`        | `--provider ollama`       | Talks to a running Ollama server over HTTP.            |
| `openai-compat` | `--provider openai-compat`| Any OpenAI `/v1` endpoint (LM Studio, vLLM, …).        |
| `llamacpp`      | `--provider llamacpp`     | Loads a `.gguf` in-process via `node-llama-cpp`.       |
| `anthropic`     | `--provider anthropic`    | Claude via the native API. `arterm auth set anthropic`. |
| `openai`        | `--provider openai`       | ChatGPT models via `api.openai.com`. `arterm auth set openai`. |
| `gemini`        | `--provider gemini`       | Google Gemini (OpenAI-compat endpoint). `arterm auth set gemini`. |
| `xai`           | `--provider xai`          | xAI Grok. `arterm auth set xai`.                       |
| `deepseek`      | `--provider deepseek`     | DeepSeek. `arterm auth set deepseek`.                  |
| `groq`          | `--provider groq`         | Groq. `arterm auth set groq`.                          |
| `openrouter`    | `--provider openrouter`   | OpenRouter. `arterm auth set openrouter`.              |
| `mistral`       | `--provider mistral`      | Mistral. `arterm auth set mistral`.                    |

### Signing in to a cloud provider

Hosted providers need an API key. Store it once (encrypted, AES-256-GCM) and
Arterm uses it automatically:

```bash
arterm auth set openai       # paste the key when prompted (read from stdin)
arterm auth set gemini --value "$GEMINI_API_KEY"
arterm auth list             # show stored key names
arterm auth remove xai       # delete one

arterm --provider openai --model gpt-4o
arterm --provider gemini --model gemini-2.0-flash
```

The key name is the provider id. As a fallback, each provider also reads its
conventional env var (`OPENAI_API_KEY`, `GEMINI_API_KEY`, `XAI_API_KEY`,
`DEEPSEEK_API_KEY`, `GROQ_API_KEY`, `OPENROUTER_API_KEY`, `MISTRAL_API_KEY`,
`ANTHROPIC_API_KEY`).

`node-llama-cpp` is **optional** and not installed by default (its native
binaries are large). The `llamacpp` provider imports it lazily and prints a clear
error if it is missing. Install it and drop GGUF files into `~/.arterm/models/`:

```bash
npm install -g node-llama-cpp
arterm --provider llamacpp --model <file.gguf>
```

## Security

Arterm runs models that can read your files and execute shell commands, so it is
built to be safe by default:

- **Directory sandbox** — `read`, `write`, `edit`, `ls`, `glob`, and `grep` are
  confined to the working directory; paths and glob patterns that escape it
  (absolute paths, `..` segments) are refused — even the auto-allowed search
  tools cannot read e.g. `~/.ssh` or `/etc`.
- **Permission prompts** — `write`, `edit`, and `bash` ask before every call
  unless you opt out per-tool ("always allow") or globally (`--yolo`).
- **Dangerous-command guard** — a few obviously destructive `bash` patterns
  (`rm -rf /`, `mkfs`, fork bombs, …) are refused outright. This is
  defense-in-depth only; the permission prompt is the real guard.
- **Local by default** — no telemetry and no network calls beyond the model
  backend you configure.

> Tools see whatever is in the working directory, including secrets in files like
> `.env`. Run Arterm from a project directory you trust, and prefer the default
> (prompting) mode over `--yolo` on untrusted code.

## Config

Configuration lives in `~/.arterm/` and is created on demand.
`~/.arterm/config.json` fields:

| Field              | Description                                          | Default                  |
| ------------------ | ---------------------------------------------------- | ------------------------ |
| `provider`         | Active provider id.                                  | `"ollama"`               |
| `model`            | Active model (Ollama tag or `.gguf` filename).       | `"llama3.2"`             |
| `ollamaHost`       | Ollama server URL (env `OLLAMA_HOST` overrides).     | `http://127.0.0.1:11434` |
| `openaiCompatHost` | OpenAI-compatible base URL (incl. `/v1`).            | `http://localhost:1234/v1` |
| `modelsDir`        | Directory of `.gguf` files for `llamacpp`.           | `~/.arterm/models`       |
| `temperature`      | Sampling temperature.                                | `0.7`                    |
| `permissions`      | Per-tool overrides, persisted by "always allow".     | `{}`                     |

## Development

A pnpm + TypeScript (ESM) monorepo. The dependency direction is one-way:
everything depends on `core`, which owns the shared interfaces.

| Package             | Responsibility                                                            |
| ------------------- | ------------------------------------------------------------------------ |
| `@arterm/core`      | Shared types, the agent loop, config, event bus, permissions, tool protocol. |
| `@arterm/providers` | `OllamaProvider`, `OpenAICompatProvider`, `LlamaCppProvider` + registry.  |
| `@arterm/tools`     | The file & shell tools and their registry.                               |
| `@arterm/tui`       | The Ink terminal UI: chat, status bar, model picker, permission prompts.  |
| `arterm-cli`        | The published `arterm` binary (commander + session wiring).              |

```bash
pnpm install
pnpm -r build      # build every package
pnpm -r test       # run the test suites
node packages/cli/dist/main.js   # run the locally-built CLI
```

See [CLAUDE.md](./CLAUDE.md) for the contributor guide.

## License

[MIT](./LICENSE) © Arclude
