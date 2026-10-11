#!/usr/bin/env python3
"""tui-probe.py — drive pi's REAL interactive TUI through a scenario via a PTY.

The RPC replay (replay.mjs) proves the compaction wedge at the session layer, but the
user-visible report is about the interactive UI ("/export stopped functioning"), and the
TUI has its own input routing (slash dispatch vs. the isCompacting queue). This probe
runs the actual TUI against the mock backend and types what a human would type, so we
can see with our own eyes which commands respond while compaction is stuck.

    python3 tui-probe.py --sandbox <agentDir> --port <mockPort> --out <file> [--hang]

Scenario: startup -> prompt (triggers auto-compaction) -> /export -> /golden-status.
The captured screen is greppable ANSI text; look for "exported", "Queued message",
"Failed to export", "Compaction".
"""
import argparse
import os
import pty
import select
import subprocess
import sys
import time

p = argparse.ArgumentParser()
p.add_argument("--sandbox", required=True)
p.add_argument("--port", type=int, required=True)
p.add_argument("--out", required=True)
p.add_argument("--hang", action="store_true", help="sandbox mock is in MOCK_HANG_SUMMARY mode")
p.add_argument("--session", default=None, help="session .jsonl to resume (must live OUTSIDE the sandbox agent dir)")
p.add_argument("--cwd", default=os.getcwd())
args = p.parse_args()

env = dict(os.environ)
env["PI_CODING_AGENT_DIR"] = args.sandbox
env["LLAMA_BASE_URL"] = f"http://127.0.0.1:{args.port}"
env["TERM"] = "xterm-256color"

master, slave = pty.openpty()
cmd = ["pi", "--model", "mock/tinyclip", "--approve", "--offline"]
if args.session:
    cmd += ["--session", args.session]
proc = subprocess.Popen(
    cmd,
    stdin=slave, stdout=slave, stderr=slave,
    cwd=args.cwd, env=env, close_fds=True,
)
os.close(slave)

buf = b""
def pump(seconds):
    """Drain PTY output for `seconds`, appending to buf."""
    global buf
    end = time.time() + seconds
    while time.time() < end:
        r, _, _ = select.select([master], [], [], max(0.05, end - time.time()))
        if r:
            try:
                chunk = os.read(master, 65536)
            except OSError:
                return
            if not chunk:
                return
            buf += chunk

def send(line, wait):
    os.write(master, line.encode() + b"\r")
    pump(wait)

pump(6.0)                       # startup + first paint
send("hello, please summarize where we are\n", 12.0)   # prompt; auto-compaction fires near the 24k edge
send("/export\n", 4.0)          # the user-reported command
send("/golden-status\n", 4.0)   # extension command (runs even while compacting)
send("/session\n", 3.0)
pump(1.0)

try:
    proc.terminate()
except Exception:
    pass
pump(1.0)

text = buf.decode("utf-8", "replace")
with open(args.out, "w") as f:
    f.write(text)
print(f"wrote {args.out} ({len(buf)} bytes raw)")

# Cheap screen-level verdict: strip CSI sequences and look for known strings.
import re
plain = re.sub(r"\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b[=>]", "", text)
for needle in ["Session exported to", "Failed to export", "Queued message for after compaction",
               "Compaction", "golden-status", "golden-context: enabled", "Cannot submit a prompt",
               "isCompacting", "Compaction cancelled"]:
    print(f"  {'YES' if needle in plain else ' no'}  {needle!r}")
