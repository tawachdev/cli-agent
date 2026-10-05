import os, pty, sys, time, select, signal, re

BUN = sys.argv[1]
AGENT_TS = sys.argv[2]
AGENT_URL = sys.argv[3]
GOOD_KEY = sys.argv[4]
WORKSPACE = sys.argv[5]

import fcntl, termios, struct
pid, master = pty.fork()
if pid == 0:
    env = dict(os.environ, TERM="xterm-256color", AGENT_URL=AGENT_URL)
    os.chdir(WORKSPACE)
    os.execve(BUN, [BUN, "run", AGENT_TS], env)

buf = ""
failed = False

def flat():
    clean = re.sub(r"\x1b\[[0-9;?]*[A-Za-z]", "", buf)
    return re.sub(r"\s+", " ", clean)

def drain(duration):
    global buf
    end = time.time() + duration
    while time.time() < end:
        r, _, _ = select.select([master], [], [], 0.1)
        if r:
            try:
                data = os.read(master, 65536)
                if data:
                    buf += data.decode("utf-8", "replace")
            except OSError:
                break

def wait_for(pattern, timeout, label):
    global failed
    end = time.time() + timeout
    while time.time() < end:
        if re.search(pattern, flat()):
            print(f"OK: {label}")
            return True
        drain(0.2)
    print(f"FAIL: {label} — pattern {pattern!r} not found")
    clean = re.sub(r"\x1b\[[0-9;?]*[A-Za-z]", "", buf)[-2000:]
    print("LAST OUTPUT:\n" + clean)
    failed = True
    return False

def send(data):
    os.write(master, data.encode())

fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))

steps = [
    (r"Ask anything", 20, "prompt ready"),
    (r"welcome to mimon", 10, "wizard opened via /setup"),
    (r"API key for mockmind", 10, "mockmind selected in wizard"),
    (r"pick a model", 25, "key tested — model picker open"),
    (r"done — .* drives all .* tiers", 25, "model picked and tiers bound, back in chat"),
    (r"Labas khouya", 40, "answer streamed in the box"),
]

drain(6.0)
wait_for(*steps[0])
send("/setup\r")
wait_for(*steps[1])
for _ in range(5):
    send("\x1b[B")
    time.sleep(0.08)
send("\r")
wait_for(*steps[2])
send(GOOD_KEY + "\r")
wait_for(*steps[3])
send("\r")
wait_for(*steps[4])
time.sleep(0.4)
send("salam\r")
wait_for(*steps[5])
drain(1.0)
try:
    os.write(master, b"\x03")
except OSError:
    pass
drain(1.5)
try:
    os.kill(pid, signal.SIGKILL)
except Exception:
    pass
try:
    os.waitpid(pid, 0)
except Exception:
    pass

box_tops = len(re.findall("╭", buf.split("\x1b[2J")[-1])) if "\x1b[2J" in buf else -1
print(f"box_tops_last_frame={box_tops}")
ok = not failed
print("RESULT:", "PASS" if ok else "FAIL")
sys.exit(0 if ok else 1)
