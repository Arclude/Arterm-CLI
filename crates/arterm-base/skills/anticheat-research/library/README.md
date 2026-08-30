# Field notes — the growing library

`techniques/` is the stable taxonomy: how each class works, in general. This
directory is the opposite — the specific, accumulating record of what real
analyses taught. It is the part that makes arterm evolve: every analysis writes
back here, so the next one starts sharper than the last.

## What goes here (and what does not)

**Here:** concrete, target-specific findings —
- a real AOB signature that located a value, and how stable it proved across
  updates;
- a variant of a technique you had not seen (a new injection vector, an unusual
  validation pattern);
- a counter-measure that held, or one that looked good and did not;
- a recovered struct layout for a specific engine;
- a threat-model call for a class of target ("this engine ships positions
  unfiltered; assume ESP-open").

**Not here:** the general taxonomy (that is `techniques/`), and anything that is
a turnkey cheat against a live third-party product (that is out of scope — see
`../SKILL.md`). Field notes are defensive knowledge: what the opening was and how
to close it, not a weaponized artifact.

## Format

One file per target or per technique-deepening, named so it is findable:
`ENGINE-or-TARGET__technique__YYYY-MM-DD.md`. Inside, keep the three lanes the
taxonomy uses so notes merge cleanly back toward `techniques/` when a pattern
generalizes:

```
# <target> — <technique>

Date, binary hash / version, how the target's provenance was confirmed.

## Find
What located the opening. Real addresses, real signatures, real offsets.

## Detect
What caught it, or would. What was tried and failed.

## Harden
The fix recommended, and — if known — whether it held.

## Generalizes?
Does this belong back in techniques/<file>.md as a general lesson, or is it
target-specific? Note it, so the taxonomy grows deliberately, not by accident.
```

## The feedback loop

When a field note's "Generalizes?" says yes, lift the lesson up into the matching
`techniques/` file — that is how the seed taxonomy deepens over time without
becoming a dumping ground. Keep general knowledge general and specific knowledge
specific; the split is what keeps the library usable as it grows.

_(Empty for now — the first real analysis fills it.)_
