# Signature scanning (AOB / pattern scanning)

Not a cheat by itself — the primitive under nearly every other technique. Before
a cheater can read a value, hook a function, or find a timer, they must locate it
in a binary that moves between versions. Signature scanning is how: find a byte
pattern unique and stable enough to re-locate the target after every update.

## Find — how the cheater builds a signature

- Pick a target (a function, a global, an instruction that touches the value).
- Take its bytes, then **wildcard the parts that change** — relative addresses,
  offsets that shift with the build — leaving the stable opcodes. The result is
  an AOB (array of bytes) pattern like `48 8B 05 ?? ?? ?? ?? 48 85 C0`.
- Scan the module's memory for that pattern at runtime. If it is unique, the
  cheat has re-found its target without hardcoding an address — so it survives
  the next patch, as long as the pattern still matches.
- A good signature is **short enough to survive minor changes, unique enough to
  match one place.** Cheaters trade these two off; that tradeoff is the opening
  you attack.

## Detect

- **Not directly detectable.** Scanning is read-only pattern matching over the
  cheat's own copy or the process memory — there is no anomalous call to catch.
  Do not promise a runtime detector for scanning itself.
- What you *can* detect is the technique the scan enables (the hook, the memory
  write). Detection lives in those files, not here.

## Harden — make the signature fragile

The goal is not to stop scanning; it is to break the cheater's *stable* signature
every build, so their cheat needs re-authoring each update instead of surviving.

- **Compiler-level obfuscation** — control-flow flattening, opaque predicates,
  instruction substitution change the byte pattern of a function without changing
  its behavior. A signature over an obfuscated function is far harder to keep
  stable.
- **Function reordering per build** — randomize function layout so relative
  offsets in signatures shift. Cheap, and it invalidates offset-based signatures.
- **Duplicate/decoy code** — plausible near-copies of a hot function so a
  signature matches multiple places and the cheat picks wrong.
- **Hot-path value indirection** — route the value the cheater wants through an
  extra layer (a getter, a computed offset) so the instruction they would
  signature is not the one that holds the truth.

## What the analysis should produce

For the functions and values other findings flagged: how stable a signature over
them would be. A short, unique, unobfuscated prologue on a sensitive function is a
weakness — a cheat built against it will survive updates cheaply. The hardening is
to make that prologue move or blend every build. Report the *fragility*, and note
that the value of obfuscation here is raising maintenance cost, not prevention.
