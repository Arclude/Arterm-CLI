#!/usr/bin/env python3
"""Verify the late OSC 11 reply drain against a cold-start launch.

The bug the user saw: arterm queries OSC 11 at startup, times out at 120ms,
and by the time the terminal's answer arrives arterm has already left raw
mode (e.g. it failed to start a server and printed its "to resume" hint), so
the kernel echoes the reply into the shell.

This drives that exact path: no server on the custom socket, reply arrives at
DELAY_S, and we check whether the reply bytes leak into the terminal output.
"""
import os, pty, select, socket, subprocess, sys, tempfile, threading, time

BIN = sys.argv[1] if len(sys.argv) > 1 else "./target/selfdev/arterm"
DELAY_S = float(sys.argv[2]) if len(sys.argv) > 2 else 0.5

sock_path = os.path.join(tempfile.mkdtemp(prefix="arterm-osc11-"), "arterm.sock")

master, slave = pty.openpty()
env = dict(os.environ)
env["TERM"] = "xterm-256color"
env.pop("TERM_PROGRAM", None)
env.pop("LC_TERMINAL", None)
env.pop("ARTERM_THEME", None)
env["ARTERM_SOCKET"] = sock_path
env["ARTERM_NO_UPDATE"] = "1"

def feed_late_reply():
    time.sleep(DELAY_S)
    os.write(master, b"\x1b]11;rgb:0909/0b0b/0c0c\x1b\\")

threading.Thread(target=feed_late_reply, daemon=True).start()

# Launch with an invalid provider so server spawn fails fast after the echo
# window, and arterm exits while the reply is still in flight.
proc = subprocess.Popen(
    [BIN, "--no-selfdev", "--provider", "missing-provider-xyz"],
    stdin=slave, stdout=slave, stderr=slave,
    env=env, close_fds=True,
)
os.close(slave)

output = b""
deadline = time.time() + 25
while time.time() < deadline:
    r, _, _ = select.select([master], [], [], 0.5)
    if r:
        try:
            chunk = os.read(master, 65536)
        except OSError:
            break
        if not chunk:
            break
        output += chunk
    if proc.poll() is not None:
        end = time.time() + 3
        while time.time() < end:
            r, _, _ = select.select([master], [], [], 0.2)
            if not r:
                break
            try:
                output += os.read(master, 4096)
            except OSError:
                break
        break

try:
    proc.wait(5)
except subprocess.TimeoutExpired:
    proc.kill()

bad = b"11;rgb:0909/0b0b/0c0c" in output
print(f"echoed_reply={'YES - BUG PRESENT' if bad else 'no (drained)'}")
sys.exit(1 if bad else 0)
