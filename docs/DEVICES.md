# Devices: pairing, peer sessions, and cross-machine switching

How two machines share arterm sessions over the local network: pairing, the
peer transport, switching to a session that lives on another machine, and the
traps the tooling now guards against.

## The model

- Every machine has a **device identity** (name + fingerprint) created on
  first use. `arterm device show` prints it.
- Two machines **pair** by a one-time invite (`device invite` / `device join`).
  Pairing is mutual trust; after that either machine may reach the other.
- A paired machine **serves its sessions** to peers automatically: once at
  least one device is paired, the daemon opens the peer port itself
  (`ARTERM_NO_PEER_SERVICE=1` disables that). `arterm device listen` is the
  foreground equivalent, for machines that do not run the daemon.
- Switching to a remote session from the TUI loads the **full conversation
  from the peer** and keeps the session's **own working directory** — the
  local machine's cwd is never written into the remote session.

## Pairing two machines

On the machine that will accept connections (the "server" side):

```
arterm device invite
```

This mints a one-time `arterm://...` token naming this machine's address and
fingerprint. On the other machine:

```
arterm device join 'arterm://192.168.1.42:7644#<fingerprint>.<secret>'
```

Both sides now trust each other (`arterm device list`). Use
`arterm device sessions` to see sessions across all paired machines, grouped
by device, local first.

## Peer sessions

- `arterm device connect <device>` opens a session on a paired machine from
  your terminal. `--remote-working-dir` chooses the directory on the other
  side; `--proxy-socket` relays to a local socket instead of opening the TUI
  (this is what the TUI's own remote-session switcher uses).
- The transport is mTLS: both machines verify certificate fingerprints from
  their trust stores, and connections are refused unless both machines are on
  the same subnet.
- `arterm device forget <device>` removes the trust; the port stops being
  reachable for it.

## The `ARTERM_SOCKET` inheritance trap

`device listen` splices peers into whatever daemon owns the socket from
`crate::server::socket_path()`. That resolution is environment-first: if the
listener process inherits `ARTERM_SOCKET` from its shell — for example when
started from inside another arterm session's shell — peers are silently
joined to **that** daemon, which may be a completely different arterm home
than the one whose sessions you think you are serving.

There is no reliable way to detect the wrong daemon from inside: the
inherited path can even be the default socket path of a different runtime
dir. So the banner is explicit instead:

```
$ ARTERM_SOCKET=/run/user/1000/arterm.sock arterm device listen
toygar is accepting peer connections.

  address      192.168.1.5:7644
  fingerprint  F343-629F-A2CD-A997
  daemon socket /run/user/1000/arterm.sock

Note: ARTERM_SOCKET=/run/user/1000/arterm.sock was inherited from this
shell's environment, so peers will be joined to the daemon at that path.
Unset it to serve this machine's own daemon.
```

If the inherited socket is exactly this machine's own default socket, no
note is printed. The daemon's built-in peer service is not affected by this
trap at all (same process owns the socket).

## Boot sessions and remote switching

Switching to a remote session creates a short-lived local "boot session".
These are now cleaned up automatically: when a resume lands on a real
target, unused boot-session files are deleted in-band, and a startup sweep
removes any stragglers left by crashes. See `docs/RESUME_BEHAVIOR.md` for
the resume-side details.
