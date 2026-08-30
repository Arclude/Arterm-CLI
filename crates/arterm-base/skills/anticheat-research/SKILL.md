---
name: anticheat-research
description: Use when analyzing a binary or game for cheat susceptibility, understanding how a cheat technique works or how cheaters find an opening, designing detection or hardening against a technique, or reproducing a technique in a lab to build a counter-measure. Drives IDA Pro MCP for binary analysis and consults a growing technique library. Defensive research only.
allowed-tools: bash, read, write, grep, todo
---

# Anti-Cheat Research

Analyze a binary for cheat susceptibility, understand how cheaters find and build against openings, and produce the defense: detection signatures and hardening. Reproduce a technique in a lab only to counter it.

## Scope — read this first, every time

This skill is for **defensive research**: understanding a technique, reproducing it in a controlled lab, and building detection and hardening against it. You cannot defend against what you do not understand, so "how the cheater finds the opening" is in scope — it is half of every technique entry.

**Out of scope, no exceptions:**
- A working, deployable cheat aimed at a **live third-party product**.
- Detection evasion — helping a cheat avoid an anti-cheat — for any purpose other than a documented, authorized test of your own protection.

If a request crosses that line, say so plainly and offer the defensive equivalent: the detection or hardening for the same technique. Do not moralize; state the boundary in a sentence and pivot to the work you can do.

The legitimate targets are: a binary you own, a lab target you built, or an authorized engagement whose scope you have confirmed. If the target's provenance is unclear, ask before analyzing.

## The method

Every analysis follows one loop. Do not improvise the order — each step feeds the next.

1. **Confirm the target is legitimate** (see scope). If unsure, stop and ask.
2. **Consult the library before looking.** Read `techniques/00-index.md`, then the technique files relevant to the target. The library tells you *what to look for* and *which IDA query answers it* — you are running a checklist, not guessing.
3. **Analyze with IDA Pro MCP.** Follow `ida-playbook.md`: it maps each question ("where do sensitive values live?", "is this validated client-side?") to the exact IDA MCP tool. Work top-down: map the binary, then drill into the functions the library flags.
4. **Cross-reference findings against the library.** For each opening you find, name the technique it enables from the taxonomy. A finding without a named technique is incomplete — say what a cheater would *do* with it.
5. **Produce the four outputs** (below), scaled to what the user asked for.
6. **Grow the library.** Write what this analysis taught back into `library/` — a new variant, a real signature, a counter-measure that did or did not hold. This is what makes the next analysis sharper. See `library/README.md` for the format.

## The one truth to surface every time

Most hardening in the taxonomy collapses to one thing: **server authority.** No value held client-side is ultimately protectable — the client runs on the user's machine, and the user owns it. Encrypting memory, shuffling offsets, scanning for hooks all *slow* the cheater; they do not stop them. A value validated on the server cannot be cheated by editing client memory.

So the most valuable output is usually the finding "this check happens client-side and belongs on the server." Everything else is a layer that delays the arms race. When you write a report, lead with the client-side-trust findings; present memory encryption, offset randomization, and hook scanning as the delaying layers they are, not as fixes.

## The four outputs

Produce what the user asked for; default to the first three.

1. **Analysis report** — which cheat techniques the target is open to, *where* (function, address, value) and *why*. Each finding names a technique and states what a cheater would do with it.
2. **Hardening recommendations** — concrete changes per finding: move the check server-side, encrypt the value, add an integrity check, randomize the offset. Rank by leverage: server-authority fixes first, delaying layers after.
3. **Detection signatures** — how to catch the technique at runtime: IAT/inline hook scans, statistical checks on impossible inputs, cross-checked time sources. Note which are directly detectable and which (e.g. pure memory reads, signature scanning) are not — for those, the answer is to make the technique fragile, not to detect it.
4. **Lab PoC** (only when asked, and only within scope) — reproduce the technique against a lab target to prove the counter-measure works. The PoC exists to validate the defense, not to ship. Never build one against a live third-party product.

## The technique library

Seven seed techniques, each a file under `techniques/`, each with three lanes — how the cheater **finds** the opening, how you **detect** the technique, how you **harden** against it:

- `techniques/memory.md` — memory reading / writing (ESP, god mode)
- `techniques/injection-hooking.md` — DLL injection, IAT/inline/VMT hooking
- `techniques/signature-scanning.md` — AOB/pattern scanning, the cheater's most basic tool
- `techniques/speedhack-timing.md` — hooking timing functions
- `techniques/aimbot-esp.md` — position reads + input injection
- `techniques/packet-manipulation.md` — MITM on the protocol
- `techniques/kernel.md` — driver-based access below user-mode AC

These are seeds. Read `techniques/00-index.md` for how they relate, and deepen them as you analyze: real signature patterns, variants you meet, counter-measures that held and that did not. The library is both input and output.

## When you finish

State plainly what you verified against the binary versus what you inferred, and which library entries you updated. A report that does not distinguish "confirmed in the disassembly" from "likely, by pattern" is not finished.
