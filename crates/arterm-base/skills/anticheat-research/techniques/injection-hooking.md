# Code injection / hooking

The cheater runs their own code inside the game's process, then redirects the
game's own function calls through it. Injection gets the code in; hooking gives
it control. Together they enable persistent memory edits, ESP overlays drawn
through the game's renderer, and interception of anything the game does.

## Find — how the cheater locates the opening

- **Injection vectors.** `LoadLibrary` (simplest, most detectable), manual
  mapping (loads a DLL without registering it, evades module walks), reflective
  DLL (the DLL maps itself). Finding the vector is about what the process and
  its anti-cheat allow, not about the binary's logic.
- **Hook targets.** To hook a function the cheater must first find it:
  - **IAT/EAT** — the import/export tables name functions directly; overwrite
    the pointer and calls route through the cheat.
  - **Inline/detour** — overwrite the first bytes of the target with a jump.
    Needs the function's address, found by signature scanning (see
    `signature-scanning.md`).
  - **VMT hooking** — for C++ games, swap an entry in an object's virtual
    method table. Found via RTTI or by locating the vtable in memory.

## Detect

- **IAT / inline hook scanning** — compare the in-memory import table and
  function prologues against the on-disk image; a mismatch is a hook. Standard
  and effective against user-mode hooks.
- **Module enumeration** — walk loaded modules; an unsigned or unexpected DLL is
  a signal. Weak against manual mapping (no module entry), so pair it with
  memory scanning for executable regions outside any module.
- **Thread start-address checks** — a thread whose start address is outside any
  legitimate module is injected code executing.
- **ntdll integrity** — many user-mode anti-cheats are themselves defeated by
  hooking ntdll first; checking ntdll against a clean copy catches that.

## Harden

- **Self-integrity hashing** — the game periodically hashes its own code
  sections and compares against known-good; an inline hook changes the hash.
  Must protect the check itself (see the arms-race note below).
- **Code signing verification** — refuse to run alongside unsigned modules, or at
  least flag them. Raises the bar; kernel cheats step around it.
- **Control-flow integrity (CFI)** — indirect calls validated against a legal
  target set; a VMT or detour hook redirects to an illegal target and trips it.
- **The arms-race caveat** — every check here runs in the same process the
  attacker controls, so a sufficiently determined cheat patches the check out.
  These raise cost and catch the majority; they are not a wall. The wall, again,
  is server authority for the decisions that matter.

## What the analysis should produce

Which functions are attractive hook targets (rendering, input, network send/recv,
anti-cheat entry points), whether the binary verifies its own integrity, and
whether it tolerates unsigned modules. A hookable network-send function with no
integrity check is a high-value finding — it enables both ESP and packet-level
cheats from one hook.
