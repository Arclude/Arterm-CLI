# Packet manipulation

Attacks the protocol rather than the binary. The cheat sits between client and
server (or hooks the game's send/recv) and modifies, drops, delays, or replays
packets: lag switches (drop your outgoing packets to freeze your character while
you still see others), teleport (edit position packets), or forging actions the
client would never legitimately send. The weak point is any decision the server
takes on the client's word.

## Find — how the cheater locates the opening

- **Reverse the protocol.** Capture traffic (or hook `send`/`recv`, see
  `injection-hooking.md`) and map which bytes mean what — position, action,
  sequence number. If the protocol is unencrypted, this is straightforward.
- **Find the trusted fields.** The cheater looks for fields the server acts on
  without re-checking: a position the server accepts as-is (teleport), a
  "hit registered" flag the client asserts (fabricated kills), an inventory
  action with no server-side validation.
- **Man-in-the-middle vs in-process.** A proxy MITM edits packets on the wire; a
  hook edits them inside the process before encryption. If the protocol is
  encrypted end-to-end, the cheater must hook inside the process (before
  encryption), which raises the bar and ties this class back to injection.

## Detect

- **Server-side consistency checks** — a position that jumped further than
  max-speed allows since the last update, an action out of legal sequence, a hit
  claimed from an impossible angle. The server has the ground truth; use it.
- **Sequence and replay validation** — monotonic sequence numbers and
  nonces catch dropped, reordered, or replayed packets (lag-switch and replay
  cheats).
- **Rate and sanity limits** — actions per second, state transitions that skip
  required steps.

## Harden

- **Server-authoritative state — the core fix.** The server never takes the
  client's word for a competitive outcome: position, hits, inventory, and
  currency are computed and validated server-side. The client *requests*; the
  server *decides*. A forged packet requesting an illegal state is simply
  rejected.
- **Authenticated encryption (AEAD)** on the protocol — encryption alone hides
  the payload but does not stop tampering; a MAC (built into AEAD like
  AES-GCM or ChaCha20-Poly1305) makes an edited packet fail verification. This
  pushes the cheater from wire-MITM to in-process hooking.
- **Sequence integrity** — per-packet nonce/counter under the MAC, so replay and
  reorder are detectable and rejected.

## What the analysis should produce

For a networked target: which fields the server trusts without re-validation, and
whether the protocol is authenticated (not just encrypted). A server that accepts
client-reported position or hit results is the highest-leverage finding in the
whole taxonomy — it makes teleport, speed, and aimbot-hit cheats trivial and no
client-side hardening can close it. The fix is always "the server must decide,
not verify the client's claim."
