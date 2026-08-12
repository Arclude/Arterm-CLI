# The TypeScript implementation, archived

Arterm was a TypeScript agent before it was a Rust one. That implementation was
removed from this repository when the Rust tree became the product; these files
are what was kept, and they are **documents about code that is no longer here**.

They are archived rather than deleted for one reason: the code was the cheap
part. What is expensive is knowing *why* a control has the shape it has, and
most of that reasoning was never written anywhere else.

- **`CLAUDE.md`** is the contributor guide, and the bulk of it is incident
  record: the sandbox's fail policy (unattended fails closed, attended fails
  open) and why the boundary may never come from model output; why the verify
  gate's command fails closed while its judge fails open; why the chronicle
  records the seam rather than the story; why prompt-cache breakpoints sit where
  they do; why `homedir()` belongs to exactly one file. Several of these are
  still unbuilt on the Rust side and are the reference for building them —
  `arterm-command-risk` is deliberately NOT one of them (it is better than the
  TypeScript deny-list it would replace).
- **`SECURITY.md`** described the TypeScript product's controls. It is archived
  rather than carried forward on purpose: it documents a sandbox and a
  permission ladder the Rust tree does not have yet, and a security document
  that promises a control which is not there is worse than none. A Rust
  `SECURITY.md` has to be written against what the Rust code actually does.
- The remaining files are design notes and audits from that period, including
  the Turkish-language research notes.

Everything here describes `packages/` at the commit before its removal. The code
itself is in the git history, and `git log` on this directory finds the
reasoning that produced it.
