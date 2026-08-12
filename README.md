# Arterm

A terminal AI coding agent, written in Rust.

There was a TypeScript implementation; it was removed when this tree became the
product. What was worth keeping from it is archived under
[docs/legacy-typescript/](./docs/legacy-typescript/) — documents, not code,
because the reasoning behind its controls is the part that was expensive.

## Provenance

This is a fork of **[jcode](https://github.com/1jehuang/jcode)** by Jeremy
Huang, used under the MIT license. Upstream's notice is carried verbatim in
[LICENSE-jcode](./LICENSE-jcode), beside this project's own
[LICENSE](./LICENSE); see [ATTRIBUTION.md](./ATTRIBUTION.md) for what was taken
and what has since been changed.

The upstream project's own README is kept at
[docs/UPSTREAM_README.md](./docs/UPSTREAM_README.md). It is preserved for
reference and **its claims belong to jcode, not to this fork**: the benchmark
tables, RAM measurements and feature demos there were measured against
upstream, and nothing in them has been re-measured here. Treat that file as a
document about another project until a number in it has been reproduced.

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

83 crates, layered so that high-churn orchestration depends on stable
contracts and never the reverse:

```
arterm (bin + cli dispatch)
 └─ arterm-tui               presentation
     └─ arterm-app-core      agent loop, tools, server
         └─ arterm-base      providers, config, session, auth, memory
             └─ contracts    arterm-provider-core, arterm-tool-core,
                             arterm-protocol, arterm-*-types
```

[ARCHITECTURE.md](./ARCHITECTURE.md) records why the layers sit that way, and
which upstream designs are deliberately *not* being carried over.

## Status

The suite is green and the binary completes real turns against a live provider.
The open work is the safety layer: this tree has no sandbox and no per-tool
permission prompt, which the removed TypeScript implementation did have — its
design notes are in `docs/legacy-typescript/CLAUDE.md`, and
`SECURITY.md` was archived rather than carried forward for exactly that reason.
What is already better here is `arterm-command-risk`, which classifies commands
by blast radius rather than by name.
