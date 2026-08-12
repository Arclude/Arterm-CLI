# Arterm

A terminal AI coding agent, written in Rust.

83 crates, a real TUI, multi-model routing and swarm coordination, with the
agent loop, tool registry and session server all in-process. It runs local and
hosted models through one provider layer, and it is built to be driven
unattended as readily as interactively.

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
