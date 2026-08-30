# Kernel-level cheats

The top of the escalation. A cheat running in kernel mode (ring 0) reads and
writes the game's memory from below any user-mode anti-cheat, which cannot see or
stop it. This is where the arms race goes when user-mode defenses get good, and it
is honest to say up front: there is no user-mode fix. Countering it requires
matching the cheat's privilege level — a kernel-mode anti-cheat — and even then
it stays a moving target.

## Find — how the cheater gets to ring 0

- **Vulnerable signed driver (BYOVD).** Load a legitimately-signed but buggy
  driver and exploit it to run arbitrary kernel code. Popular because it needs no
  self-signed driver — the signature belongs to a real vendor.
- **Self-signed / test-signed driver.** On systems with driver signature
  enforcement disabled (test mode, or an exploited bootloader), load the cheat's
  own driver directly.
- Once in the kernel, the cheat reads game memory via the kernel's view of
  physical memory, bypassing user-mode handle checks entirely. From the game's
  perspective nothing suspicious happened in its own address space.

## Detect

- **Kernel-mode anti-cheat** (the EAC / BattlEye model) — runs its own driver so
  it operates at the same level as the cheat and can inspect kernel state, loaded
  drivers, and physical-memory access patterns.
- **Driver signature enforcement + revocation** — refuse known-vulnerable
  drivers (BYOVD blocklists), and require DSE be on to launch.
- **Hypervisor-based integrity** — a thin hypervisor above the OS enforces memory
  protections the kernel itself cannot be trusted to enforce; the escalation past
  this is a cheat with its own hypervisor.
- Detection here is behavioral and probabilistic — unexpected physical-memory
  access, a driver that should not be present — not a clean signature.

## Harden

- **There is no user-mode hardening for this.** Say so in the report rather than
  listing user-mode measures that a ring-0 cheat steps around. Encrypting memory
  or scanning for hooks in user mode does nothing against a kernel reader.
- The real answer is a **kernel-mode anti-cheat**, which is a build-vs-buy
  decision (EAC, BattlEye, or in-house) with real cost, kernel stability risk,
  and its own attack surface. It is an arms race, not a wall.
- **Escalate the value, not the protection.** Even against a kernel cheat,
  server authority still holds for the decisions that live on the server: a
  kernel god-mode edit to client health means nothing if the server computes
  health. This is why the server-authority lens survives even at the top of the
  escalation — it is the one defense the cheater's privilege level cannot reach.

## What the analysis should produce

Recognize when a target's threat model actually requires kernel-mode defense
(competitive multiplayer with a serious cheating market) versus when it does not
(single-player, casual, or anything where server authority already covers the
competitive values). Do not recommend a kernel anti-cheat reflexively — it is
heavy, risky, and unnecessary if the valuable decisions are already server-side.
The finding is a threat-model judgment: "user-mode defenses are the ceiling here,
and here is what a kernel cheat would still reach — which is / is not
server-protected."
