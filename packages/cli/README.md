# arterm-cli

A terminal AI coding agent that runs **local** models — [Ollama](https://ollama.com),
any **OpenAI-compatible** endpoint (LM Studio, vLLM, …), or a `.gguf` loaded
in-process. Rich Ink TUI, live streaming, an interactive model picker, and
permission-gated file/shell tools sandboxed to your working directory.

## Install

Requires **Node.js >= 22**.

```bash
npm install -g arterm-cli
# or: npx arterm-cli
```

## Quick start

```bash
ollama serve            # start a model backend (https://ollama.com)
ollama pull qwen2.5:7b
arterm --model qwen2.5:7b
```

Inside the TUI: type to chat, `Enter` to send, `?` for help, **Alt+P** to pick a
model, `Esc` to cancel a turn, `Ctrl+C` to quit. `write`/`edit`/`bash` ask for
permission before running (use `--yolo` to skip).

```bash
arterm                 # interactive chat (default)
arterm models          # list models across providers
arterm pull <model>    # download a model via Ollama
```

Full documentation, providers, security model, and config:
**https://github.com/Arclude/Arterm-CLI**

## License

MIT © Arclude
