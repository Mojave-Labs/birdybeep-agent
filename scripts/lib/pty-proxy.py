#!/usr/bin/env python3
"""Run a command on a pseudo-terminal while relaying this process's stdin/stdout.

Gives a spawned CLI a REAL tty (so `process.stdin.isTTY` is true and an interactive
prompt actually engages) while the PARENT still drives it over ordinary pipes and
observes its true exit status — which `tui-drive.py` cannot do, since that helper
plays a canned key script and then kills the child.

Used by scripts/live-e2e-pair-confirm.mjs to answer `birdybeep pair`'s confirmation
prompt the way a human at a terminal does, mid-run, and then assert the exit code.

POSIX-only (uses the `pty` module); callers guard on platform.

Usage: pty-proxy.py <cmd> [args...]   → exits with the child's status.
"""
import fcntl
import os
import pty
import select
import struct
import sys
import termios

cmd = sys.argv[1:]
if not cmd:
    sys.stderr.write("pty-proxy: no command given\n")
    sys.exit(2)

pid, fd = pty.fork()
if pid == 0:
    # Child: a plain terminal type; nothing here should try to draw a full-screen UI.
    os.environ["TERM"] = "dumb"
    os.execvp(cmd[0], cmd)

# A real window size — without it some CLIs render a degenerate 1-column layout.
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))

stdin_fd = sys.stdin.fileno()
stdin_open = True
while True:
    watch = [fd] + ([stdin_fd] if stdin_open else [])
    ready, _, _ = select.select(watch, [], [], 0.2)
    if fd in ready:
        try:
            data = os.read(fd, 65536)
        except OSError:  # EIO: the child closed the pty (it exited)
            break
        if not data:
            break
        os.write(sys.stdout.fileno(), data)
    if stdin_open and stdin_fd in ready:
        data = os.read(stdin_fd, 65536)
        if not data:
            stdin_open = False  # parent closed the pipe; keep draining the child
        else:
            os.write(fd, data)

_, status = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status))
