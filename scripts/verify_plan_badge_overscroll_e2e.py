#!/usr/bin/env python3
"""E2E on the installed binary through the real TUI key path.

Boots the real TUI in a PTY, toggles Plan Mode ON via the real Alt+P key
event (injected through the debug-command file channel so the TUI's own
key-event dispatch runs - no PTY byte guessing), registers the Down
overscroll gesture, then verifies via the same file channel:
  1. `state`: `plan_mode` is true and `overscroll_active` is true
  2. `screen-json`: the header carries no `· plan` badge, and the overscroll
     status row (pinned visible by the isolated config) leads with `plan`

Environment isolation mirrors the tester harness: ARTERM_HOME pins
`overscroll_status = "on"` (the default 1.5s elastic dwell cannot be observed
through the ~5s debug-command poll cadence), ARTERM_RUNTIME_DIR/ARTERM_SOCKET
spawn a private server, and ARTERM_NO_PEER_SERVICE avoids port collisions.
"""
import json, os, pty, select, subprocess, sys, tempfile, termios, threading, time

BIN = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser("~/.arterm/builds/current/arterm")

work = tempfile.mkdtemp(prefix="arterm-plan-e2e-")
cmd_path = os.path.join(work, "debug_cmd")
resp_path = os.path.join(work, "debug_response")

master, slave = pty.openpty()
# The PTY kernel echoes everything the child writes back to it, so the TUI's
# own OSC queries (and any reply we write) would be re-read as input and
# pollute the composer. Turn echo off before the child starts.
attrs = termios.tcgetattr(master)
attrs[3] &= ~termios.ECHO  # lflags: no echo
termios.tcsetattr(master, termios.TCSANOW, attrs)

env = dict(os.environ)
env["TERM"] = "xterm-256color"
for k in ("TERM_PROGRAM", "LC_TERMINAL", "ARTERM_THEME", "ARTERM_SOCKET"):
    env.pop(k, None)
env["ARTERM_NO_UPDATE"] = "1"
rt_dir = os.path.join(work, "rt")
os.makedirs(rt_dir)
home_dir = os.path.join(work, "home")
os.makedirs(home_dir)
# Pin the overscroll status line ON: `overscroll` (the default) is a 1.5s
# elastic reveal, which the ~5s debug-command poll cadence cannot observe
# mid-dwell. `on` keeps the line permanently below the input so the frame
# dump can capture the plan badge in that row.
with open(os.path.join(home_dir, "config.toml"), "w") as f:
    f.write('[display]\noverscroll_status = "on"\n')
env["ARTERM_HOME"] = home_dir
env["ARTERM_RUNTIME_DIR"] = rt_dir
env["ARTERM_SOCKET"] = os.path.join(rt_dir, "s.sock")
env["ARTERM_NO_PEER_SERVICE"] = "1"
env["ARTERM_DEBUG_CMD_PATH"] = cmd_path
env["ARTERM_DEBUG_RESPONSE_PATH"] = resp_path

# Single reader thread owns master. Anything else reading master races this
# thread; a losing os.read() then blocks forever on an empty PTY.
buf = bytearray()
def reader():
    answered = False
    deadline = time.time() + 120
    while time.time() < deadline:
        r, _, _ = select.select([master], [], [], 0.2)
        if not r:
            continue
        try:
            chunk = os.read(master, 65536)
        except OSError:
            return
        if not chunk:
            continue
        buf.extend(chunk)
        if not answered and b"\x1b]11;?" in bytes(buf):
            os.write(master, b"\x1b]11;rgb:0909/0b0b/0c0c\x1b\\")
            answered = True

threading.Thread(target=reader, daemon=True).start()

proc = subprocess.Popen(
    [BIN, "--no-selfdev", "--provider", "arterm"],
    stdin=slave, stdout=slave, stderr=slave, env=env, close_fds=True,
)
os.close(slave)

def wait(seconds):
    end = time.time() + seconds
    while time.time() < end:
        select.select([master], [], [], 0.1)

wait(14)  # startup: isolated server spawn + TUI boot
if b"\x1b[?1049h" not in bytes(buf):
    print(f"BOOT FAIL: TUI never entered the alt screen ({len(buf)} bytes)")
    print("output:", repr(bytes(buf)[:600]))
    proc.kill()
    sys.exit(2)

def run_debug(cmd, timeout=10.0):
    """Send a debug command through the file channel and await its response.

    The TUI polls the command file on its event-loop tick (~5s cadence), so
    the wait window must comfortably exceed one poll interval.
    """
    with open(cmd_path, "w") as f:
        f.write(cmd)
    end = time.time() + timeout
    while time.time() < end:
        wait(0.05)
        if os.path.exists(resp_path):
            try:
                with open(resp_path) as f:
                    data = f.read()
                os.unlink(resp_path)
                if data:
                    return data
            except OSError:
                pass
    return None

# Toggle Plan Mode ON via a real key event through the TUI's own dispatch.
keys_resp = run_debug("keys:alt+p")
print(f"keys:alt+p -> {keys_resp!r}")
# Down at the bottom registers the elastic overscroll gesture (a no-op for
# the reveal itself while overscroll_status is pinned "on", but it still runs
# the real key path).
keys_resp2 = run_debug("keys:down")
print(f"keys:down -> {keys_resp2!r}")
state_raw = run_debug("state")
state = {}
try:
    state = json.loads(state_raw) if state_raw else {}
except json.JSONDecodeError:
    pass
print(f"state.plan_mode={state.get('plan_mode')}")
print(f"state.overscroll_active={state.get('overscroll_active')}")
print(f"state.overscroll_remaining={state.get('overscroll_remaining')}")

frame = run_debug("screen-json")
try:
    proc.kill()
except Exception:
    pass
if proc.poll() is None:
    proc.wait(3)

if not frame:
    print("FAIL: no screen-json response from the running TUI")
    sys.exit(2)
with open("/tmp/plan_frame_last.json", "w") as f:
    f.write(frame)

payload = json.loads(frame)
rows = []
rt = payload.get("rendered_text")
if isinstance(rt, dict):
    # Structured dump: assemble candidate visible rows from its sections.
    sections = []
    for key in ("header_preview", "status_line", "overscroll_status", "input_area", "input_hint"):
        v = rt.get(key)
        if isinstance(v, str):
            sections.append(v)
    for m in rt.get("recent_messages") or []:
        if isinstance(m, dict) and isinstance(m.get("content_preview"), str):
            sections.append(m["content_preview"])
    rows = sections
else:
    cells = payload.get("cells") or payload.get("rows") or []
    if isinstance(cells, list) and cells and isinstance(cells[0], list):
        for row in cells:
            rows.append("".join(str(c.get("char", c.get("symbol", "")) if isinstance(c, dict) else c) for c in row))
    elif isinstance(cells, list):
        rows = [str(c) for c in cells]

joined = "\n".join(rows)
header_badge = any(("arterm" in r and "plan" in r and "·" in r) for r in rows)
overscroll = [r for r in rows if "plan" in r and "arterm" not in r]
print(f"header_plan_badge={'YES-FAIL' if header_badge else 'no (removed)'}")
print(f"overscroll_rows_with_plan={len(overscroll)}")
for r in overscroll[:2]:
    print("  row:", r.strip()[:100])
state_ok = state.get("plan_mode") is True and state.get("overscroll_active") is True
ok = (not header_badge) and bool(overscroll) and state_ok
print("result=" + ("PASS" if ok else "CHECK"))
sys.exit(0 if ok else 1)
