# Memory reading / writing

The oldest and most common class. An external process (or injected code) reads
the game's memory to see values it should not — enemy positions (ESP/wallhack),
health, cooldowns — or writes memory to change values it should not — god mode,
infinite ammo, movement speed. Everything here rests on the game keeping a
meaningful value in a findable place, in the clear.

## Find — how the cheater locates the opening

- **Value scanning.** Cheat Engine's core loop: search all memory for a known
  value (health = 100), take damage, search again for the new value (health =
  80), repeat until one address remains. No reversing needed — the game tells
  the cheater where the value is by changing it.
- **Pointer scanning.** The address from value scanning moves between runs
  (ASLR, heap allocation). The cheater finds a stable *pointer chain* — a base
  module offset plus a sequence of dereferences — that resolves to the value
  every launch. This is what makes a cheat survive restarts.
- **Structure analysis.** Once one field is found (health), nearby fields
  (armor, position, team) sit at fixed offsets in the same entity struct. Find
  the struct once, get every field for free.

## Detect

- **Integrity checks on critical values** — keep a shadow copy or checksum and
  compare; a write the game did not make is a cheat. Weak against an attacker
  who also patches the check.
- **External handle monitoring** — an unexpected process holding an
  `OpenProcess` handle with `VM_READ`/`VM_WRITE` on the game is a strong signal
  on Windows. Enumerable via handle tables (needs care, often kernel-assisted).
- **Honeypot values** — a plausible-looking value that the legitimate game never
  reads; anything that writes it is a cheat that scanned into it.

## Harden

- **Server authority first.** If health, ammo, and position are validated
  server-side, the client can hold whatever it likes in memory — the server
  rejects an impossible state. This is the fix; the rest are delays.
- **Encrypt sensitive values in memory**, decrypting only at the moment of use
  (e.g. store `health ^ key`, or a small struct behind a XOR/rotating key).
  Defeats naive value scanning: the searched value is never in memory.
- **Randomize offsets per build** — reorder struct fields, insert padding, so a
  pointer chain found against one version breaks on the next. Raises the
  cheater's maintenance cost every update.

## What the analysis should produce

For a given binary: which sensitive values live in plain memory, whether they are
server-validated, and whether a stable pointer chain exists. A value that is
(a) in the clear, (b) client-authoritative, and (c) reachable by a stable
pointer is a confirmed opening — name it, and say which higher technique it
enables (ESP, god mode, etc.).
