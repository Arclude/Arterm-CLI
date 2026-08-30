# Speedhack / timing manipulation

The game advances its simulation by reading a clock. A speedhack hooks that clock
and lies about how much time has passed — the game thinks more (or less) time
elapsed and speeds up, slows down, or fast-forwards cooldowns. Purely a
consequence of the game trusting a client-side time source.

## Find — how the cheater locates the opening

- Identify which time source the game reads. Common ones on Windows:
  `QueryPerformanceCounter`, `timeGetTime`, `GetTickCount`/`GetTickCount64`,
  `rdtsc`. Found in the import table (see `../ida-playbook.md`) or by tracing
  the frame/update loop back to its time read.
- **Hook the timer** (see `injection-hooking.md`) and scale its return value.
  Return `real_delta * 2` and the game runs at double speed; the game did the
  rest itself.
- The cheater's only real work is finding *which* timer the game trusts and
  hooking that one — everything downstream is the game's own logic.

## Detect

- **Cross-check multiple time sources.** Read two independent clocks (e.g.
  `QueryPerformanceCounter` and `GetTickCount`) and compare their deltas; a
  speedhack usually hooks one, so they diverge. The cheater must hook all of
  them consistently to defeat this, which raises their cost.
- **Server-side timing validation.** The server measures wall-clock time between
  the client's actions; a client claiming 100 actions in a server-second is
  cheating regardless of what its local clock says. This is the reliable
  detector.
- **Sanity on rates** — cooldowns completing faster than possible, movement
  covering more distance than the max speed allows in the elapsed server time.

## Harden

- **Server-authoritative movement and timing.** The definitive fix: the server,
  not the client, decides how far a player moved and whether a cooldown is up,
  using the server's own clock. The client's clock becomes advisory.
- **Never gate a competitive value on client time.** Cooldowns, movement, and
  ability timers computed from a client clock are always cheatable; compute them
  server-side.
- If a value genuinely must be client-timed (single-player, cosmetic), accept
  that it is cheatable and do not spend hardening budget pretending otherwise.

## What the analysis should produce

Which time source the update loop trusts, and whether any competitive value
(movement, cooldown, spawn timer) is derived from client time rather than server
time. A client-timed cooldown is a confirmed speedhack opening — the fix is to
move the timing decision to the server, not to protect the timer.
