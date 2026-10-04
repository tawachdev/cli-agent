import os, pty, time, fcntl, termios, struct, sys, re, select, signal

def set_size(fd, cols, rows):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))

pid, master = pty.fork()
if pid == 0:
    os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    env = dict(os.environ, TERM="xterm-256color", AGENT_DB_PATH="/tmp/ptytest.db", AGENT_WORKSPACE_ROOT="/tmp/ptytest")
    os.execve("/opt/homebrew/bin/bun", ["bun", "run", "bin/agent.ts"], env)

set_size(master, 120, 40)
buf = b""
def drain(t):
    global buf
    end = time.time() + t
    while time.time() < end:
        r, _, _ = select.select([master], [], [], 0.1)
        if r:
            try:
                data = os.read(master, 65536)
                if data:
                    buf += data
            except OSError:
                break

drain(3.0)
alt = b"\x1b[?1049h" in buf
for cols, rows in [(120, 40), (90, 30), (70, 24), (55, 18), (90, 30), (120, 40), (50, 12), (40, 8), (120, 40)]:
    set_size(master, cols, rows)
    drain(1.0)
try:
    os.write(master, b"\x03")
except OSError:
    pass
drain(0.8)
try:
    os.kill(pid, signal.SIGKILL)
except Exception:
    pass
try:
    os.waitpid(pid, 0)
except Exception:
    pass

text = buf.decode("utf-8", "replace")
clears = text.count("\x1b[2J")
asks = len(re.findall(r"Ask anything", text))
final = text.rsplit("\x1b[2J", 1)[-1] if clears else text
final_asks = len(re.findall(r"Ask anything", final))
final_tops = len(re.findall(r"╭", final))
print(f"alt_screen={alt} clears={clears} total_ask={asks}")
print(f"FINAL: ask={final_asks} tops={final_tops}")
ok = alt and clears >= 5 and final_asks == 1 and final_tops == 1
print("RESULT:", "PASS" if ok else "FAIL")
sys.exit(0 if ok else 1)
