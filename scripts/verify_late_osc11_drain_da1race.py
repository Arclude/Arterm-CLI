#!/usr/bin/env python3
"""Verify the drain for the DA1-races-OSC11 case the user actually hit.

The user's log showed `the terminal does not support querying for its colors`:
colorsaurus sends OSC 11 then DA1; the PTY here answers DA1 immediately and
OSC 11 only after DELAY_S. colorsaurus concludes "unsupported" and exits raw
mode while the color reply is still in flight, so the kernel echoes it into
the shell. The drain must consume it either way.
"""
import os, pty, re, select, subprocess, sys, tempfile, threading, time

BIN = sys.argv[1] if len(sys.argv) > 1 else "./target/selfdev/arterm"
DELAY_S = float(sys.argv[2]) if len(sys.argv) > 2 else 0.4

sock_path = os.path.join(tempfile.mkdtemp(prefix="arterm-osc11-"), "arterm.sock")

master, slave = pty.openpty()
env = dict(os.environ)
env["TERM"] = "xterm-256color"
env.pop("TERM_PROGRAM", None)
env.pop("LC_TERMINAL", None)
env.pop("ARTERM_THEME", None)
env["ARTERM_SOCKET"] = sock_path
env["ARTERM_NO_UPDATE"] = "1"

# Watch the master for arterm's queries and answer on its behalf.
def answer_queries():
    seen = b""
    osc11_answered = False
    deadline = time.time() + 15
    while time.time() < deadline and not osc11_answered:
        r, _, _ = select.select([master], [], [], 0.2)
        if not r:
            continue
        try:
            seen += os.read(master, 65536)
        except OSError:
            return
        # Answer DA1 immediately every time it appears.
        while b"\x1b[c" in seen:
            os.write(master, b"\x1b[?1;2c")
            seen = seen.replace(b"\x1b[c", b"", 1)
        # Answer the OSC 11 query late.
        if b"\x1b]11;?" in seen:
            def late():
                time.sleep(DELAY_S)
                os.write(master, b"\x1b]11;rgb:0909/0b0b/0c0c\x1b\\")
            threading.Thread(target=late, daemon=True).start()
            osc11_answered = True

threading.Thread(target=answer_queries, daemon=True).start()

proc = subprocess.Popen(
    [BIN, "--no-selfdev", "--provider", "arterm"],
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
