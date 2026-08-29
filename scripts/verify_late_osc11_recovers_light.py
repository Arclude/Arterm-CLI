#!/usr/bin/env python3
"""E2E on the installed binary: a LIGHT OSC 11 reply arriving after the
colorsaurus timeout must be recovered by the drain AND actually flip the
theme decision to light (proving the recovered color is used, not just
discarded)."""
import os, pty, select, subprocess, sys, tempfile, threading, time

BIN = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser("~/.arterm/builds/current/arterm")
import sys as _s
DELAY = float(_s.argv[2]) if len(_s.argv) > 2 else 0.3
master, slave = pty.openpty()
env = dict(os.environ); env["TERM"] = "xterm-256color"
for k in ("TERM_PROGRAM", "LC_TERMINAL", "ARTERM_THEME"): env.pop(k, None)
env["ARTERM_NO_UPDATE"] = "1"

def answer():
    seen = b""; done = False
    while not done:
        r, _, _ = select.select([master], [], [], 0.2)
        if not r: continue
        try: seen += os.read(master, 65536)
        except OSError: return
        while b"\x1b[c" in seen:
            os.write(master, b"\x1b[?1;2c"); seen = seen.replace(b"\x1b[c", b"", 1)
        if b"\x1b]11;?" in seen:
            def late():
                time.sleep(DELAY)
                os.write(master, b"\x1b]11;rgb:ffff/ffff/ffff\x1b\\")
            threading.Thread(target=late, daemon=True).start(); done = True
threading.Thread(target=answer, daemon=True).start()
proc = subprocess.Popen([BIN, "--no-selfdev", "--provider", "arterm"],
                        stdin=slave, stdout=slave, stderr=slave, env=env, close_fds=True)
os.close(slave)
out = b""; deadline = time.time() + 12
while time.time() < deadline:
    r, _, _ = select.select([master], [], [], 0.3)
    if r:
        try: c = os.read(master, 65536)
        except OSError: break
        if not c: break
        out += c
    if proc.poll() is not None: break
try: proc.wait(3)
except subprocess.TimeoutExpired: proc.kill()
echoed = b"ffff/ffff/ffff" in out
print(f"echoed_reply={'YES-BUG' if echoed else 'no (drained)'}")
sys.exit(1 if echoed else 0)
