# Aimbot / ESP

Two cheats sharing a foundation. **ESP** (extra-sensory perception: wallhacks,
radar, name/health tags) reads entity data the player should not see and draws it
on screen. **Aimbot** reads enemy positions and either injects mouse movement to
aim, or writes the player's view angles directly. Both start from the same
opening — the client knows where every entity is — so hardening them is one
problem, not two.

This class is fundamentally a **detection** problem, not a prevention one. As long
as the client renders the world, it must know entity positions to draw them; you
cannot fully hide from the client what the client draws.

## Find — how the cheater locates the opening

- **Entity positions in memory** — found via memory/pointer scanning
  (`memory.md`) and structure analysis: locate the entity list, then position
  and team fields at fixed offsets. This one read enables ESP and aimbot both.
- **View-angle write** — for a memory-write aimbot, find the local player's
  pitch/yaw and write the angle that points at the target. For an input-injection
  aimbot, feed synthesized mouse deltas instead (harder to detect, since the
  angle changes the way a real input would).
- **World-to-screen** — for ESP overlays, the cheat reuses the game's own
  view-projection matrix (found in memory) to place 3D positions on the 2D
  screen.

## Detect

- **Statistical analysis, server-side.** Aimbot leaves a signature in *how* the
  aim moves: impossible flick angles, snap-to-target with zero settle time,
  perfect tracking through occlusion, hit rates and headshot ratios far outside
  the human distribution. This is the primary detector and it lives on the
  server, on the stream of inputs.
- **Occlusion checks** — a player reacting to an enemy they cannot possibly see
  (behind a wall, before line-of-sight) is using ESP. Server-side, compare what
  the player *could* see against what they *reacted to*.
- **Client-side is weak** — an input-injection aimbot mimics real input closely,
  so client-side input analysis is easily fooled. Do not lean on it.

## Harden

- **Server-side hit validation** — the server confirms the shot was possible
  (line of sight, no wall, plausible angle) before registering the hit. An aimbot
  that snaps through a wall still misses because the server says so.
- **Don't send what the client can't see.** The strongest ESP defense: the
  server withholds the positions of entities the player has no line of sight to,
  so they are not in client memory to read. Costs server work (per-player
  visibility) and cannot be perfect (nearby unseen enemies), but it removes the
  opening for anything fully occluded. Often called "fog of war" enforcement.
- Accept the residual: entities the client legitimately renders are always
  ESP-able. Spend the budget on the visibility server-side, and on statistical
  detection for the rest.

## What the analysis should produce

Whether the client receives (and holds in memory) positions of entities the
player cannot see — the ESP opening — and whether hits are validated server-side
for line of sight and angle. A client that receives all entity positions
regardless of visibility is open to wallhacks and aimbots at once; the finding is
"move visibility filtering and hit validation to the server."
