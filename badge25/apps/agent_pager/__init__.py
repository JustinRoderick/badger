import sys
import os

sys.path.insert(0, "/system/apps/agent_pager")
os.chdir("/system/apps/agent_pager")

from badgeware import io, brushes, shapes, screen, PixelFont, run
import network
import socket
import json
import gc

# Agent Pager: a remote control for coding agents.
#
# The badge polls a small bridge server on your computer (see
# badge25/apps/agent_pager/README.md) and shows what each agent is doing.
# When an agent asks for permission the badge takes over the screen so you
# can allow or deny it without going back to your desk.

small_font = PixelFont.load("/system/assets/fonts/ark.ppf")
large_font = PixelFont.load("/system/assets/fonts/absolute.ppf")

white = brushes.color(235, 245, 255)
phosphor = brushes.color(211, 250, 55)
background = brushes.color(13, 17, 23)
panel = brushes.color(33, 40, 48)
gray = brushes.color(110, 118, 129)
blue = brushes.color(48, 148, 255)
orange = brushes.color(255, 166, 0)
red = brushes.color(248, 81, 73)
green = brushes.color(46, 160, 67)

dim_blue = brushes.color(20, 70, 130)
dim_orange = brushes.color(120, 78, 0)

STATUS_COLORS = {
    "running": blue,
    "waiting": orange,
    "error": red,
    "done": green,
    "idle": gray,
}

WIFI_TIMEOUT_MS = 30000
POLL_ACTIVE_MS = 2000
POLL_IDLE_MS = 6000
HOLD_MS = 1500
SOCKET_TIMEOUT_S = 4
ROW_HEIGHT = 12
LIST_TOP = 14
LIST_BOTTOM = 106
VISIBLE_ROWS = (LIST_BOTTOM - LIST_TOP) // ROW_HEIGHT

# -- config ------------------------------------------------------------------

WIFI_SSID = None
WIFI_PASSWORD = None
PAGER_HOST = None
PAGER_PORT = 8787
PAGER_TOKEN = ""


def load_config():
    global WIFI_SSID, WIFI_PASSWORD, PAGER_HOST, PAGER_PORT, PAGER_TOKEN
    try:
        sys.path.insert(0, "/")
        import secrets
        sys.path.pop(0)
    except ImportError:
        return
    WIFI_SSID = getattr(secrets, "WIFI_SSID", None) or None
    WIFI_PASSWORD = getattr(secrets, "WIFI_PASSWORD", None)
    PAGER_TOKEN = getattr(secrets, "PAGER_TOKEN", "") or ""
    url = getattr(secrets, "PAGER_URL", "") or ""
    if url.startswith("http://"):
        url = url[7:]
    url = url.rstrip("/")
    if ":" in url:
        host, port = url.split(":", 1)
        PAGER_HOST, PAGER_PORT = host, int(port)
    elif url:
        PAGER_HOST = url


# -- networking --------------------------------------------------------------

wlan = None
wifi_started = None
connected = False


def wifi_ready():
    global wlan, wifi_started, connected
    if connected and wlan.isconnected():
        return True
    if wlan is None:
        wlan = network.WLAN(network.STA_IF)
        wlan.active(True)
        if not wlan.isconnected():
            wlan.connect(WIFI_SSID, WIFI_PASSWORD)
        wifi_started = io.ticks
    connected = wlan.isconnected()
    return connected


def wifi_timed_out():
    return wifi_started is not None and io.ticks - wifi_started > WIFI_TIMEOUT_MS


def http(method, path, body=None):
    """Tiny HTTP/1.0 client with a hard socket timeout, so a missing server
    can never freeze the badge for long."""
    payload = json.dumps(body).encode() if body is not None else b""
    head = (
        "{} {} HTTP/1.0\r\nHost: {}\r\nAuthorization: Bearer {}\r\n"
        "Content-Type: application/json\r\nContent-Length: {}\r\n\r\n"
    ).format(method, path, PAGER_HOST, PAGER_TOKEN, len(payload))
    sock = socket.socket()
    try:
        sock.settimeout(SOCKET_TIMEOUT_S)
        sock.connect(socket.getaddrinfo(PAGER_HOST, PAGER_PORT)[0][-1])
        sock.send(head.encode() + payload)
        chunks = []
        while True:
            chunk = sock.recv(1024)
            if not chunk:
                break
            chunks.append(chunk)
    finally:
        sock.close()
    raw = b"".join(chunks)
    del chunks
    split = raw.find(b"\r\n\r\n")
    status = int(raw[9:12])
    data = json.loads(raw[split + 4:]) if split >= 0 and len(raw) > split + 4 else {}
    del raw
    gc.collect()
    if status != 200:
        raise OSError(data.get("error", "HTTP {}".format(status)))
    return data


# -- state -------------------------------------------------------------------

threads = []
pending = []
prompts = []
server_name = ""
last_poll = None
last_poll_ok = None
poll_error = None
snoozed = set()

view = "list"           # list | detail | pending | prompts
selected = 0            # index into list rows
selected_id = None      # keeps the selection on the same thread across re-sorts
scroll = 0
pending_index = 0
option_index = 0
prompt_index = 0
detail_id = None

toast_text = None
toast_until = 0
press_started = {}
hold_fired = set()


def poll():
    global threads, pending, prompts, server_name, last_poll, last_poll_ok, poll_error
    last_poll = io.ticks
    try:
        data = http("GET", "/badge/state")
    except Exception as e:
        poll_error = describe_error(e)
        return
    poll_error = None
    last_poll_ok = io.ticks
    threads = data.get("threads", [])
    pending = data.get("pending", [])
    prompts = data.get("prompts", [])
    server_name = data.get("server", "")
    live_ids = set(p["id"] for p in pending)
    for request_id in list(snoozed):
        if request_id not in live_ids:
            snoozed.discard(request_id)


OFFLINE_ERRNOS = (104, 110, 111, 113, 54, 60, 61, 65)  # reset, timeout, refused, unreachable (Linux + macOS)


def describe_error(e):
    code = e.args[0] if e.args and isinstance(e.args[0], int) else None
    if code in OFFLINE_ERRNOS or isinstance(e, OSError) and "timed out" in str(e):
        return "Bridge offline: {}:{}".format(PAGER_HOST, PAGER_PORT)
    return str(e) or "Bridge error"


def act(body, success):
    try:
        data = http("POST", "/badge/action", body)
        toast(data.get("message") or success)
    except Exception as e:
        toast("Failed: {}".format(describe_error(e)))
    poll()


def toast(text):
    global toast_text, toast_until
    toast_text = text
    toast_until = io.ticks + 2500


def poll_interval():
    busy = pending or any(t.get("status") == "running" for t in threads)
    return POLL_ACTIVE_MS if busy else POLL_IDLE_MS


def unsnoozed_pending():
    return [p for p in pending if p["id"] not in snoozed]


def list_rows():
    """The list view shows one 'needs you' row for snoozed requests, then threads."""
    rows = []
    if pending:
        rows.append(("pending", None))
    for thread in threads:
        rows.append(("thread", thread))
    return rows


def find_thread(thread_id):
    for thread in threads:
        if thread.get("id") == thread_id:
            return thread
    return None


# -- input helpers -----------------------------------------------------------

def track_presses():
    for button in io.pressed:
        press_started[button] = io.ticks
        hold_fired.discard(button)


def tapped(button):
    """True on release of a short press (so the same button can also be held)."""
    return button in io.released and button not in hold_fired


def hold_progress(*buttons):
    """0..1 for how long all `buttons` have been held together."""
    if not all(b in io.held for b in buttons):
        return 0
    start = max(press_started.get(b, io.ticks) for b in buttons)
    return min(1, (io.ticks - start) / HOLD_MS)


def held_long(*buttons):
    if hold_progress(*buttons) >= 1 and not any(b in hold_fired for b in buttons):
        for b in buttons:
            hold_fired.add(b)
        return True
    return False


# -- case LEDs ---------------------------------------------------------------

LEDS = []
try:
    LEDS = [io.LED_TOP_LEFT, io.LED_TOP_RIGHT, io.LED_BOTTOM_LEFT, io.LED_BOTTOM_RIGHT]
except AttributeError:
    pass


def set_leds(level):
    global LEDS
    for led in LEDS:
        try:
            io.led[led] = level
        except Exception:
            LEDS = []
            return


def update_leds():
    """Blink when an agent needs you, breathe while agents are working."""
    if pending:
        set_leds(255 if (io.ticks // 250) % 2 else 0)
    elif any(t.get("status") == "running" for t in threads):
        phase = (io.ticks // 20) % 100
        set_leds(abs(50 - phase) * 2)
    else:
        set_leds(0)


def on_exit():
    set_leds(0)


# -- drawing helpers ---------------------------------------------------------

def fill(brush, x, y, w, h):
    screen.brush = brush
    screen.draw(shapes.rectangle(x, y, w, h))


def clip(text, width):
    if screen.measure_text(text)[0] <= width:
        return text
    while text and screen.measure_text(text + "..")[0] > width:
        text = text[:-1]
    return text + ".."


def wrap(text, width, max_lines):
    lines = []
    for paragraph in str(text).split("\n"):
        line = ""
        for word in paragraph.split(" "):
            candidate = line + " " + word if line else word
            if screen.measure_text(candidate)[0] <= width:
                line = candidate
                continue
            if line:
                lines.append(line)
            line = clip(word, width)
        lines.append(line)
        if len(lines) >= max_lines:
            break
    if len(lines) > max_lines:
        lines = lines[:max_lines]
    return lines


def center(text, y):
    w, _ = screen.measure_text(text)
    screen.text(text, 80 - w // 2, y)


def header(title, brush, right=""):
    fill(panel, 0, 0, 160, 12)
    screen.font = small_font
    screen.brush = brush
    screen.text(title, 3, 1)
    if right:
        screen.brush = gray
        w, _ = screen.measure_text(right)
        screen.text(right, 157 - w, 1)


def footer(*hints):
    """hints are (label, brush) pairs spread across the bottom bar."""
    fill(panel, 0, 108, 160, 12)
    screen.font = small_font
    slot = 160 // len(hints)
    for i, (label, brush) in enumerate(hints):
        screen.brush = brush
        w, _ = screen.measure_text(label)
        screen.text(label, i * slot + (slot - w) // 2, 109)


def hold_bar(progress, brush):
    if progress > 0:
        fill(brush, 0, 106, int(160 * progress), 2)


def status_dot(status, x, y):
    brush = STATUS_COLORS.get(status, gray)
    if status == "running" and (io.ticks // 400) % 2:
        brush = dim_blue
    if status == "waiting" and (io.ticks // 200) % 2:
        brush = dim_orange
    screen.brush = brush
    screen.draw(shapes.circle(x, y, 3))


def draw_message(title, body, brush=white):
    fill(background, 0, 0, 160, 120)
    screen.font = large_font
    screen.brush = brush
    center(title, 38)
    screen.font = small_font
    screen.brush = gray
    y = 58
    for line in wrap(body, 150, 4):
        center(line, y)
        y += 10


# -- views -------------------------------------------------------------------

def update_list():
    global view, selected, selected_id, scroll, detail_id, prompt_index, pending_index, option_index
    rows = list_rows()
    for i, (kind, thread) in enumerate(rows):
        if kind == "thread" and thread["id"] == selected_id:
            selected = i
    if io.BUTTON_UP in io.pressed:
        selected -= 1
    if io.BUTTON_DOWN in io.pressed:
        selected += 1
    selected = max(0, min(selected, len(rows) - 1)) if rows else 0
    selected_id = rows[selected][1]["id"] if rows and rows[selected][0] == "thread" else None
    if selected < scroll:
        scroll = selected
    if selected >= scroll + VISIBLE_ROWS:
        scroll = selected - VISIBLE_ROWS + 1

    current = rows[selected] if rows else None
    stop_all = hold_progress(io.BUTTON_A, io.BUTTON_C)
    if held_long(io.BUTTON_A, io.BUTTON_C):
        act({"type": "interrupt_all"}, "Stopped all agents")
    elif current and current[0] == "thread" and held_long(io.BUTTON_B):
        act({"type": "interrupt", "thread": current[1]["id"]}, "Interrupted")
    elif tapped(io.BUTTON_B) and current:
        if current[0] == "pending":
            snoozed.clear()
            pending_index = option_index = 0
            view = "pending"
        else:
            detail_id = current[1]["id"]
            view = "detail"
    elif tapped(io.BUTTON_C) and current and current[0] == "thread" and prompts and not stop_all:
        detail_id = current[1]["id"]
        prompt_index = 0
        view = "prompts"
    elif tapped(io.BUTTON_A) and not stop_all:
        poll()
        toast("Refreshed")

    fill(background, 0, 0, 160, 120)
    running = sum(1 for t in threads if t.get("status") == "running")
    header("AGENT PAGER", phosphor, "{} run  {} wait".format(running, len(pending)))

    if not rows and poll_error and last_poll_ok is None:
        screen.brush = gray
        center("Waiting for the bridge", 50)
        center("Is bridge.mjs running?", 62)
    elif not rows:
        screen.brush = gray
        center("No active agents", 50)
        center("Start one in T3 Code", 62)

    for i in range(scroll, min(len(rows), scroll + VISIBLE_ROWS)):
        kind, thread = rows[i]
        y = LIST_TOP + (i - scroll) * ROW_HEIGHT
        if i == selected:
            fill(panel, 0, y - 1, 160, ROW_HEIGHT)
        if kind == "pending":
            status_dot("waiting", 6, y + 5)
            screen.brush = orange
            screen.text("{} need{} you".format(len(pending), "s" if len(pending) == 1 else ""), 13, y)
            continue
        status_dot(thread.get("status"), 6, y + 5)
        screen.brush = white if i == selected else gray
        screen.text(clip(thread.get("title", "?"), 143), 13, y)

    if poll_error:
        fill(red, 0, 96, 160, 11)
        screen.brush = white
        center(clip(poll_error, 156), 97)

    progress = max(stop_all, hold_progress(io.BUTTON_B))
    hold_bar(progress, red)
    if stop_all:
        footer(("Hold: STOP ALL", red))
    else:
        footer(("A:refresh", gray), ("B:open", phosphor), ("C:prompt", blue))


def update_detail():
    global view, prompt_index
    thread = find_thread(detail_id)
    if thread is None:
        view = "list"
        return
    if held_long(io.BUTTON_B):
        act({"type": "interrupt", "thread": thread["id"]}, "Interrupted")
    elif tapped(io.BUTTON_A):
        view = "list"
        return
    elif tapped(io.BUTTON_C) and prompts:
        prompt_index = 0
        view = "prompts"
        return

    fill(background, 0, 0, 160, 120)
    status = thread.get("status", "idle")
    header(status.upper(), STATUS_COLORS.get(status, gray), thread.get("age", ""))
    screen.brush = white
    y = 15
    for line in wrap(thread.get("title", ""), 154, 2):
        screen.text(line, 3, y)
        y += 10
    screen.brush = gray
    if thread.get("project"):
        screen.text(clip(thread["project"], 154), 3, y)
        y += 12
    screen.brush = phosphor if status == "running" else white
    for line in wrap(thread.get("activity", ""), 154, (104 - y) // 10):
        screen.text(line, 3, y)
        y += 10

    hold_bar(hold_progress(io.BUTTON_B), red)
    footer(("A:back", gray), ("hold B:stop", red), ("C:prompt", blue))


def update_prompts():
    global view, prompt_index
    thread = find_thread(detail_id)
    if thread is None or not prompts:
        view = "list"
        return
    if io.BUTTON_UP in io.pressed:
        prompt_index = (prompt_index - 1) % len(prompts)
    if io.BUTTON_DOWN in io.pressed:
        prompt_index = (prompt_index + 1) % len(prompts)
    if tapped(io.BUTTON_A):
        view = "detail"
        return
    if tapped(io.BUTTON_C):
        act({"type": "prompt", "thread": thread["id"], "text": prompts[prompt_index]}, "Sent")
        view = "detail"
        return

    fill(background, 0, 0, 160, 120)
    header("SEND TO", blue, "")
    screen.brush = gray
    screen.text(clip(thread.get("title", ""), 154), 3, 14)
    start = max(0, prompt_index - 6)
    for i in range(start, min(len(prompts), start + 7)):
        y = 27 + (i - start) * ROW_HEIGHT
        if i == prompt_index:
            fill(panel, 0, y - 1, 160, ROW_HEIGHT)
        screen.brush = white if i == prompt_index else gray
        screen.text(clip(prompts[i], 154), 3, y)
    footer(("A:cancel", gray), ("", gray), ("C:send", phosphor))


def update_pending():
    global view, pending_index, option_index
    queue = unsnoozed_pending()
    if not queue:
        view = "list"
        return
    pending_index = min(pending_index, len(queue) - 1)
    request = queue[pending_index]
    options = request.get("options") or []
    is_question = request.get("kind") == "question"

    if is_question:
        if io.BUTTON_UP in io.pressed:
            option_index = max(0, option_index - 1)
        if io.BUTTON_DOWN in io.pressed:
            option_index = min(len(options) - 1, option_index + 1)
    else:
        if io.BUTTON_UP in io.pressed and len(queue) > 1:
            pending_index = (pending_index - 1) % len(queue)
        if io.BUTTON_DOWN in io.pressed and len(queue) > 1:
            pending_index = (pending_index + 1) % len(queue)

    if tapped(io.BUTTON_B):
        snoozed.add(request["id"])
        option_index = 0
        return
    if tapped(io.BUTTON_A) and not is_question:
        act({"type": "respond", "id": request["id"], "decision": "deny"}, "Denied")
        return
    if tapped(io.BUTTON_C) and not (is_question and not options):
        if is_question:
            act({"type": "answer", "id": request["id"], "option": option_index}, "Answered")
        else:
            act({"type": "respond", "id": request["id"], "decision": "allow"}, "Allowed")
        option_index = 0
        return

    fill(background, 0, 0, 160, 120)
    count = "{}/{}".format(pending_index + 1, len(queue)) if len(queue) > 1 else ""
    header("QUESTION" if is_question else "NEEDS APPROVAL", orange, count)
    screen.brush = gray
    screen.text(clip(request.get("title", ""), 154), 3, 14)
    y = 26
    if is_question:
        screen.brush = white
        for line in wrap(request.get("question", ""), 154, 3):
            screen.text(line, 3, y)
            y += 10
        y += 2
        start = max(0, option_index - 3)
        for i in range(start, min(len(options), start + 4)):
            if i == option_index:
                fill(panel, 0, y - 1, 160, ROW_HEIGHT)
            screen.brush = phosphor if i == option_index else gray
            screen.text(clip(options[i], 150), 6, y)
            y += ROW_HEIGHT
        if not options:
            screen.brush = orange
            screen.text("Answer this in T3 Code", 3, y)
            footer(("", gray), ("B:later", gray), ("", gray))
        else:
            footer(("", gray), ("B:later", gray), ("C:answer", phosphor))
    else:
        screen.brush = phosphor
        screen.text(clip(request.get("tool", ""), 154), 3, y)
        y += 11
        screen.brush = white
        for line in wrap(request.get("detail", ""), 154, 7):
            screen.text(line, 3, y)
            y += 10
        footer(("A:deny", red), ("B:later", gray), ("C:allow", green))


VIEWS = {
    "list": update_list,
    "detail": update_detail,
    "prompts": update_prompts,
    "pending": update_pending,
}


def update():
    global view, pending_index, option_index

    if WIFI_SSID is None:
        load_config()
    if WIFI_SSID is None or PAGER_HOST is None:
        draw_message("Setup", "Set WIFI_SSID, PAGER_URL and PAGER_TOKEN in secrets.py")
        return
    if not wifi_ready():
        if wifi_timed_out():
            draw_message("No WiFi", "Could not join {}".format(WIFI_SSID), red)
        else:
            draw_message("WiFi", "Joining {}...".format(WIFI_SSID))
        return

    track_presses()
    if last_poll is None or io.ticks - last_poll > poll_interval():
        poll()

    # A new approval request interrupts whatever you're looking at.
    if view != "pending" and unsnoozed_pending():
        pending_index = option_index = 0
        view = "pending"

    VIEWS[view]()
    update_leds()

    if toast_text and io.ticks < toast_until:
        screen.font = small_font
        w, _ = screen.measure_text(toast_text)
        fill(phosphor, 78 - w // 2, 50, w + 6, 13)
        screen.brush = background
        center(toast_text, 52)


if __name__ == "__main__":
    run(update)
