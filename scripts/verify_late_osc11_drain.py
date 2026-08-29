#!/usr/bin/env python3
"""Verify the late OSC 11 reply drain in a PTY.

Launches the interactive arterm TUI under a PTY where the "terminal" answers
the OSC 11 background query after 200ms (past arterm's 120ms timeout). With
the drain fix the reply is consumed in raw mode and must NOT be echoed back;
without it, ^[]11;rgb:...^[\\ appears in the terminal output.
"""
import os, pty, select, subprocess, sys, threading, time

BIN = sys.argv[1] if len(sys.argv) > 1 else "./target/selfdev/arterm"
DELAY_S = float(sys.argv[2]) if len(sys.argv) > 2 else 0.2

master, slave = pty.openpty()

env = dict(os.environ)
env["TERM"] = "xterm-256color"
env.pop("TERM_PROGRAM", None)
env.pop("LC_TERMINAL", None)
env.pop("ARTERM_THEME", None)
env["ARTERM_NO_UPDATE"] = "1"

def feed_late_reply():
    time.sleep(DELAY_S)
    os.write(master, b"\x1b]11;rgb:0909/0b0b/0c0c\x1b\\")

threading.Thread(target=feed_late_reply, daemon=True).start()

proc = subprocess.Popen(
    [BIN, "--no-selfdev"],
    stdin=slave, stdout=slave, stderr=slave,
    env=env, close_fds=True,
)
os.close(slave)

output = b""
# Give the TUI time to start, consume the reply, and render.
deadline = time.time() + 8
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
        break

proc.terminate()
try:
    proc.wait(3)
except subprocess.TimeoutExpired:
    proc.kill()

# The failure signature: the reply bytes echoed back to the terminal.
bad = b"11;rgb:0909/0b0b/0c0c" in output
print(f"echoed_reply={'YES - BUG PRESENT' if bad else 'no (drained)'}")
sys.exit(1 if bad else 0)
