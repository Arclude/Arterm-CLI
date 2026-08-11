# Arterm (Rust)

A terminal AI coding agent. This tree is the Rust implementation; the
TypeScript implementation lives in `../packages`.

## Provenance

This is a fork of **[jcode](https://github.com/1jehuang/jcode)** by Jeremy
Huang, used under the MIT license. The upstream `LICENSE` is carried verbatim
and the copyright notice is unchanged — see [ATTRIBUTION.md](./ATTRIBUTION.md)
for what was taken and what has since been changed.

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
cargo test --workspace            # the suite
```

## Running it without disturbing the TypeScript CLI

Both implementations resolve their state directory to `~/.arterm`, and the
TypeScript one is the installed, working CLI — its config, keystore and
session transcripts live there. Until the two are deliberately unified, point
this build somewhere else:

```bash
ARTERM_HOME=~/.arterm-rs cargo run --bin arterm
```

The overlap is survivable rather than destructive — the file names differ
(`config.toml` vs `config.json`) and the one pruning routine is scoped to
`*.bak` files under `sessions/` — but two agents writing one state directory
in two formats is a thing to do on purpose, not by default.

Note also that upstream's install scripts place the binary at
`~/.local/bin/arterm` after the rebrand, which is exactly where the TypeScript
CLI is installed. Do not run `scripts/install*.sh` until that is settled.

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

The fork builds clean under the Arterm name. The work in progress is
integrating the subsystems the TypeScript implementation has and upstream does
not — the permission ladder, the sandbox, credential scrubbing, the
verification gate, the chronicle, and the autonomy modes.
