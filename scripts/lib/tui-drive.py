#!/usr/bin/env python3
"""Drive an interactive TUI via a pty: send scripted keys, capture raw output.

Used by the live E2E scripts (scripts/live-e2e-*.mjs) to walk a real harness's
interactive trust/onboarding dialogs headlessly — e.g. Codex's "Hooks need
review" dialog — exactly the way a human would, so trust state is produced by
the harness itself rather than forged by the test.

POSIX-only (uses the `pty` module); the callers guard on platform.

Usage: tui-drive.py <logfile> <cwd> <cmd...>
Key script comes from the TUI_SCRIPT env var, one step per line:
    <delay_seconds>:<keys>
where <keys> is ENTER, TAB, UP, DOWN, ESC, SPACE, CTRL_C, or literal text.
After the script is exhausted the child is terminated.
"""
import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios
import time

logfile, cwd = sys.argv[1], sys.argv[2]
cmd = sys.argv[3:]
script = []
for line in os.environ.get("TUI_SCRIPT", "").strip().splitlines():
    line = line.strip()
    if not line:
        continue
    delay, _, keys = line.partition(":")
    script.append((float(delay), keys))

KEYMAP = {
    "ENTER": "\r",
    "TAB": "\t",
    "UP": "\x1b[A",
    "DOWN": "\x1b[B",
    "ESC": "\x1b",
    "SPACE": " ",
    "CTRL_C": "\x03",
}

pid, fd = pty.fork()
if pid == 0:
    os.chdir(cwd)
    os.environ["TERM"] = "xterm-256color"
    os.execvp(cmd[0], cmd)

# A real window size — without it TUIs render a degenerate 1-column layout.
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
log = open(logfile, "wb")


def pump(until):
    """Read pty output until the deadline; False once the child hangs up."""
    while time.time() < until:
        ready, _, _ = select.select([fd], [], [], 0.2)
        if fd in ready:
            try:
                data = os.read(fd, 65536)
            except OSError:
                return False
            if not data:
                return False
            log.write(data)
            log.flush()
    return True


alive = True
for delay, keys in script:
    if not pump(time.time() + delay):
        alive = False
        break
    seq = KEYMAP.get(keys, keys)
    log.write(f"\n<<<SEND {keys!r}>>>\n".encode())
    try:
        os.write(fd, seq.encode())
    except OSError:
        alive = False
        break
if alive:
    pump(time.time() + 3)
try:
    os.kill(pid, signal.SIGTERM)
    time.sleep(0.5)
    os.kill(pid, signal.SIGKILL)
except ProcessLookupError:
    pass
log.close()
print("tui-drive: done")
