"""Drive the real CLI in a real pseudo-terminal: paste an image, explain it, send it.

usage: pty-composer.py BUN AGENT_TS WORKSPACE PORT IMAGE MODE
MODE is iterm, kitty or plain — which terminal the CLI should believe it runs in.
Prints one OK/FAIL line per check and exits non-zero on any failure.
"""
import fcntl, os, pty, re, select, signal, struct, sys, termios, time

BUN, AGENT_TS, WORKSPACE, PORT, IMAGE, MODE = sys.argv[1:7]
COLS, ROWS = 110, 36

TERMINALS = {
    "iterm": {"TERM": "xterm-256color", "TERM_PROGRAM": "iTerm.app"},
    "kitty": {"TERM": "xterm-kitty", "KITTY_WINDOW_ID": "1"},
    "plain": {"TERM": "xterm-256color", "COLORTERM": "truecolor"},
}

pid, master = pty.fork()
if pid == 0:
    env = {k: v for k, v in os.environ.items() if k not in ("TERM_PROGRAM", "KITTY_WINDOW_ID", "GHOSTTY_RESOURCES_DIR", "TMUX", "LC_TERMINAL")}
    env.update(TERMINALS[MODE])
    env.update(AGENT_PORT=PORT, AGENT_WORKSPACE_ROOT=WORKSPACE, AGENT_DB_PATH=os.path.join(WORKSPACE, "agent.db"), HOME=WORKSPACE)
    os.chdir(WORKSPACE)
    os.execve(BUN, [BUN, "run", AGENT_TS], env)

fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))
raw = ""
failed = False


def plain(text):
    text = re.sub(r"\x1b\][^\x07]*\x07", "", text)
    text = re.sub(r"\x1b_G[^\x1b]*\x1b\\", "", text)
    return re.sub(r"\x1b\[[0-9;?]*[A-Za-z]", "", text)


def drain(seconds):
    global raw
    end = time.time() + seconds
    while time.time() < end:
        ready, _, _ = select.select([master], [], [], 0.05)
        if ready:
            try:
                data = os.read(master, 65536)
            except OSError:
                return
            if not data:
                return
            raw += data.decode("utf-8", "replace")


def check(ok, label, detail=""):
    global failed
    print(("OK:   " if ok else "FAIL: ") + label + ("" if ok else "  " + detail))
    if not ok:
        failed = True


def wait_for(pattern, seconds, label, since=0):
    end = time.time() + seconds
    while time.time() < end:
        if re.search(pattern, plain(raw[since:])):
            check(True, label)
            return True
        drain(0.2)
    check(False, label, "never saw " + repr(pattern) + "\n--- last output ---\n" + plain(raw[-1500:]))
    return False


def send(data):
    os.write(master, data.encode())
    time.sleep(0.1)


if wait_for(r"Ask anything", 30, "prompt is ready"):
    mark = len(raw)
    send("\x1b[200~" + IMAGE + "\x1b[201~")
    wait_for(r"1 attached", 10, "pasted image waits in the composer", mark)
    drain(1.0)
    after_paste = raw[mark:]
    check("YOU" not in plain(after_paste), "pasting does not send anything")
    check(re.search(r"Say what to do with this image", plain(after_paste)) is not None, "prompt asks what to do with the image")
    if MODE == "iterm":
        hit = re.search(r"\x1b\[(\d+);(\d+)H\x1b\]1337;File=inline=1;[^:]*doNotMoveCursor=1;[^:]*width=(\d+);height=(\d+)", after_paste)
        check(hit is not None, "iTerm pixels are drawn")
        if hit:
            col, width = int(hit.group(2)), int(hit.group(3))
            check(1 < col and col + width < COLS, "iTerm pixels sit inside the box", f"col={col} width={width}")
    elif MODE == "kitty":
        check("a=t,f=100" in after_paste, "kitty receives the pixels")
        check(re.search(r"a=p,i=\d+,p=\d+,c=\d+,r=\d+", after_paste) is not None, "kitty places them by cells (c/r)")
        check(re.search(r"\x1b_G[^\x1b]*[,;]w=\d", after_paste) is None, "kitty is never asked to crop by pixels")
    else:
        check("\x1b]1337" not in after_paste and "\x1b_G" not in after_paste, "no image escapes on a plain terminal")
        check("▀" in after_paste, "half-block thumbnail is drawn")

    for cols, rows in [(80, 28), (60, 22), (COLS, ROWS)]:
        mark = len(raw)
        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
        os.kill(pid, signal.SIGWINCH)
        drain(0.8)
        check("1 attached" in plain(raw[mark:]), f"attachment survives a resize to {cols}x{rows}")

    mark = len(raw)
    send("what is in this picture?")
    send("\r")
    wait_for(r"YOU\s+what is in this picture\?", 15, "enter sends the message", mark)
    # the transcript caption carries the size; the tray caption does not
    wait_for(r"▤ shot\.png\s+120×60", 15, "the image moves into the transcript under the message", mark)
    wait_for(r"I see a teal gradient", 30, "the model's answer streams back", mark)
    check("1 attached" not in plain(raw[-4000:]), "the composer is empty again")

send("\x03")
drain(1.5)
check("\x1b[?1049l" in raw, "leaves the alternate screen on exit")
try:
    os.kill(pid, signal.SIGKILL)
except ProcessLookupError:
    pass
os.waitpid(pid, 0)
print("RESULT:", "FAIL" if failed else "PASS")
sys.exit(1 if failed else 0)
