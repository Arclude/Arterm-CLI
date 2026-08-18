# Arterm

A terminal AI coding agent, written in Rust.

83 crates, a real TUI, multi-model routing and swarm coordination, with the
agent loop, tool registry and session server all in-process. It runs local and
hosted models through one provider layer, and it is built to be driven
unattended as readily as interactively.

## Install

```bash
curl -fsSL https://arterm.dev/install | bash
```

Windows (PowerShell):

```powershell
irm https://arterm.dev/install.ps1 | iex
```

The installer resolves the latest release, verifies the download against the
release's `SHA256SUMS`, and puts the binary in `~/.local/bin` (no sudo). Set
`ARTERM_INSTALL_DIR` to put it somewhere else, or `ARTERM_VERSION=v0.10.7` to
pin a release. Uninstall with `scripts/uninstall.sh`.

## Building

```bash
cargo build --bin arterm          # debug
cargo check --workspace           # fast whole-tree check
cargo test --workspace            # the suite: 119 binaries, 8,521 tests
```

## Testing

Three layers, and one thing to know about each.

```bash
cargo test -p arterm-command-risk   # one crate, ~2s -- the everyday loop
cargo test -p arterm-tui --lib      # one big crate, ~40s
cargo test --workspace              # everything, ~6min
```

`.cargo/config.toml` gives every test binary an isolated `ARTERM_HOME` under
`target/` and runs them one at a time. Both are load-bearing rather than
tidiness: the suite has already written the developer's real `~/.arterm` by
accident, and `ARTERM_HOME` is process-global, so tests that swap it cannot run
beside tests that read it. An exported `ARTERM_HOME` still wins, so
`scripts/dev-run.sh` is unaffected.

The end-to-end path needs no API key, no network and no spend:

```bash
scripts/dev-run.sh --fake -- run "say hello in two words"
```

That starts a fake OpenAI-compatible server, points a throwaway home at it, and
runs one real turn through the real binary. `--zai` runs the same thing against
z.ai's GLM instead. Without arguments it opens the TUI.

CI additionally runs the guardrail scripts in `scripts/` — code-size, panic and
swallowed-error ratchets, crate dependency boundaries — which are not tests and
fail independently of them.

## OpenAI-compatible providers

Arterm ships profiles for 38 providers that speak the OpenAI API — Z.AI,
Cerebras, Groq, Moonshot, Nebius, Together, Hugging Face, LM Studio, Ollama and
the rest. Each one knows its own endpoint and default model, so logging in is
the provider's name and nothing else:

```bash
arterm login zai            # stores the key under ~/.config/arterm/zai.env
arterm login cerebras
arterm login ollama         # local endpoint, no key
```

`arterm login` with no argument lists them. The key is read from the profile's
env file or from its environment variable, whichever is present.

For an endpoint with no built-in profile, use the generic one and give it the
base URL:

```bash
arterm login openai-compatible \
  --api-base https://api.example.com/v1 \
  --api-key-env EXAMPLE_API_KEY
```

Or declare it in `~/.arterm/config.toml`, which is also how you pin a default
model and a context window:

```toml
[provider]
default_provider = "example"
default_model = "example-large"

[providers.example]
type = "openai-compatible"
base_url = "https://api.example.com/v1"
auth = "bearer"
api_key = "…"
default_model = "example-large"

  [[providers.example.models]]
  id = "example-large"
  context_window = 200000
```

## Layout

Layered so that high-churn orchestration depends on stable contracts and never
the reverse:

```
arterm (bin + cli dispatch)
 └─ arterm-tui               presentation
     └─ arterm-app-core      agent loop, tools, server
         └─ arterm-base      providers, config, session, auth, memory
             └─ contracts    arterm-provider-core, arterm-tool-core,
                             arterm-protocol, arterm-*-types
```

[ARCHITECTURE.md](./ARCHITECTURE.md) records why the layers sit that way.

## Status

The suite is green and the binary completes real turns against a live provider.
The open work is the safety layer: there is no sandbox and no per-tool
permission prompt yet. `arterm-command-risk` is the part that already works —
it classifies commands by blast radius rather than by name, unwraps `sudo` /
`xargs` / `timeout`, and recurses into `sh -c`. The design notes for the rest
are in [docs/legacy-typescript/](./docs/legacy-typescript/), and `SECURITY.md`
is deliberately not written yet: a security document that promises a control
which is not there is worse than none.

## License

MIT — see [LICENSE](./LICENSE) and [ATTRIBUTION.md](./ATTRIBUTION.md).
