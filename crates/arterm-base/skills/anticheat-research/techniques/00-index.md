# Technique library — index

Seven techniques, seven files. Each carries the same three lanes, because the
request behind this whole skill is "how do they find the opening, and how do we
fix it" — and those cannot be separated:

- **Find** — how a cheater locates the opening. This is the offensive half, and
  it is here on purpose: you cannot detect or harden a technique you do not
  understand from the attacker's side.
- **Detect** — how the defense catches the technique at runtime.
- **Harden** — how the defense removes or narrows the opening before runtime.

## How the techniques relate

They are not independent. There is a dependency spine:

```
signature scanning   ─┐   the cheater's "where is it" primitive;
                      │   almost everything else needs it first
                      ▼
memory read/write ──► aimbot/ESP        (read positions, write angles)
      │
      ├────────────► speedhack          (find + hook the timer)
      │
injection/hooking ──► runs cheat code inside the process
                      (enables persistent memory edits, ESP overlays)

packet manipulation   independent of the binary — attacks the protocol
kernel                below all of the above — defeats user-mode defenses
```

Read this as: **signature scanning and memory read/write are the foundation.**
If you can only harden two things, harden those, because the higher techniques
are built on them. A binary that leaks entity positions in plain memory is open
to ESP, aimbot, and radar hacks at once — one opening, three cheats.

## The single lens: server authority

Every technique's Harden lane eventually says some version of "validate on the
server." That is not repetition to trim — it is the actual answer. The client is
the attacker's machine. Client-side protections buy time in an arms race; a
server-authoritative check ends it for that value. When you analyze, the finding
that matters most is almost always "this decision is made client-side."

## Reading order for a given target

1. Is it networked (multiplayer)? Start with `packet-manipulation.md` and the
   server-authority lens — that is where the leverage is.
2. Single-player or client-trusted values? `memory.md` and
   `signature-scanning.md` are the foundation; read those first.
3. Does it already ship anti-cheat? `injection-hooking.md` and `kernel.md`
   describe the escalation the cheater will reach for.

## Growing the library

These seven files are seeds. When an analysis teaches you something concrete —
a real AOB pattern, a variant, a counter-measure that failed — it goes in
`../library/`, not here. Keep these files as the stable taxonomy; keep the
`library/` as the accumulating field notes. See `../library/README.md`.
