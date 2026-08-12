# Attribution

## Upstream

This tree is a fork of **jcode**.

- Source: https://github.com/Arclude/Arterm-CLI
- Version forked: 0.75.0
- Copyright (c) 2025 Jeremy Huang
- License: MIT — see [LICENSE](./LICENSE)

The MIT license permits use, modification and redistribution, and requires that
the copyright notice and permission notice survive in copies and substantial
portions. This file is where that notice lives; `LICENSE` carries Arclude's.

**Stated plainly so nobody has to reconstruct it later: as of 2026-08-12 the
tree is 698,473 lines of Rust, of which 2,032 were written here.** The rest is
upstream's, and the notice requirement tracks that ratio rather than the
project's name. It shrinks as the code is genuinely rewritten, which is the
stated direction; it does not shrink because the directory was renamed.
: 0.75.0
- Copyright (c) 2025 Jeremy Huang
- License: MIT — see [LICENSE](./LICENSE)

The MIT license permits use, modification and redistribution, and requires that
the copyright notice and permission notice survive in copies and substantial
portions. This file is where that notice lives; `LICENSE` carries Arclude's.

**Stated plainly so nobody has to reconstruct it later: as of 2026-08-12 the
tree is 698,473 lines of Rust, of which 2,032 were written here.** The rest is
upstream's, and the notice requirement tracks that ratio rather than the
project's name. It shrinks as the code is genuinely rewritten, which is the
stated direction; it does not shrink because the directory was renamed.

The links back to the upstream repository are excluded from every rebranding
pass for the same reason the notice is: those are provenance, not branding, and
rewriting them would point a reader at a URL that does not exist.
: 0.75.0
- Copyright (c) 2025 Jeremy Huang
- License: MIT — see [LICENSE](./LICENSE)

The MIT license permits use, modification and redistribution, and requires that
the copyright notice and permission notice survive in copies and substantial
portions. This file is where that notice lives; `LICENSE` carries Arclude's.

**Stated plainly so nobody has to reconstruct it later: as of 2026-08-12 the
tree is 698,473 lines of Rust, of which 2,032 were written here.** The rest is
upstream's, and the notice requirement tracks that ratio rather than the
project's name. It shrinks as the code is genuinely rewritten, which is the
stated direction; it does not shrink because the directory was renamed.

The links back to the upstream repository are excluded from every rebranding
pass for the same reason the notice is: those are provenance, not branding, and
rewriting them would point a reader at a URL that does not exist.
: 0.75.0
- Copyright (c) 2025 Jeremy Huang
- License: MIT — see [LICENSE](./LICENSE)

The MIT license permits use, modification and redistribution, and requires that
the copyright notice and permission notice survive in copies and substantial
portions. This file is where that notice lives; `LICENSE` carries Arclude's.

**Stated plainly so nobody has to reconstruct it later: as of 2026-08-12 the
tree is 698,473 lines of Rust, of which 2,032 were written here.** The rest is
upstream's, and the notice requirement tracks that ratio rather than the
project's name. It shrinks as the code is genuinely rewritten, which is the
stated direction; it does not shrink because the directory was renamed.

The links back to the upstream repository are excluded from every rebranding
pass for the same reason the notice is: those are provenance, not branding, and
rewriting them would point a reader at a URL that does not exist.
: 0.75.0
- Copyright (c) 2025 Jeremy Huang
- License: MIT — see [LICENSE](./LICENSE)

The MIT license permits use, modification and redistribution, and requires that
the copyright notice and permission notice survive in copies and substantial
portions. This file is where that notice lives; `LICENSE` carries Arclude's.

**Stated plainly so nobody has to reconstruct it later: as of 2026-08-12 the
tree is 698,473 lines of Rust, of which 2,032 were written here.** The rest is
upstream's, and the notice requirement tracks that ratio rather than the
project's name. It shrinks as the code is genuinely rewritten, which is the
stated direction; it does not shrink because the directory was renamed.

The links back to the upstream repository are excluded from every rebranding
pass for the same reason the notice is: those are provenance, not branding, and
rewriting them would point a reader at a URL that does not exist.

The links back to the upstream repository are excluded from every rebranding
pass for the same reason the notice is: those are provenance, not branding, and
rewriting them would point a reader at a URL that does not exist.

## What was taken

The whole workspace, minus four things that are upstream's product rather than
shared infrastructure and have no build dependency here:

| Excluded | Why |
|---|---|
| `assets/demos`, `assets/readme` | 168 MB of README media. The assets `rustc` actually reads live inside the crates that read them and were kept. |
| `ios/` | A separate Swift application. |
| `telemetry-worker/` | Upstream's hosted telemetry endpoint. |
| `.git` | A different repository's history. |

## What was changed

1. **Rebranding.** `jcode` → `arterm` across 1,263 text files: 83 crate names,
   the binary, environment variables (`JCODE_*` → `ARTERM_*`) and the state
   directory (`~/.jcode` → `~/.arterm`). The transformation is kept as
   `scripts/rebrand_to_arterm.dev` so it stays auditable.

2. **The README.** Upstream's README was carried for a while and is now
   removed. It could never have served as this project's README: a mechanical
   rename turned its measured claims — RAM comparisons, frame-rate figures,
   benchmark tables — into claims by this project that nobody here has
   measured, and pointed its badges at a repository that does not exist. Those
   numbers belong to jcode, so they left with it. `git log` finds the file.

3. **Ongoing.** Subsystems from the TypeScript Arterm implementation that
   upstream does not have are being integrated: the permission ladder and
   arbiter, the sandbox, credential scrubbing, the verification gate, the
   chronicle, and the autonomy modes. `ARCHITECTURE.md` records which upstream
   designs are deliberately not carried over, and why.
