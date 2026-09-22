#!/usr/bin/env python3
"""LiveSplit bridge (pure standard library).

Same job as livesplit-bridge.js, with nothing to install: it polls the
LiveSplit Server component on TCP 16834 and serves the state to the studio as
a WebSocket on 16835, forwarding split/reset commands back.

    python3 livesplit_bridge.py

Only loopback clients are accepted unless you pass --allow-remote, because
anything that can connect here can control your timer.
"""

import argparse
import base64
import hashlib
import json
import selectors
import socket
import struct
import threading
import time

GUID = b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
COMMANDS = {
    "split": "startorsplit", "start": "starttimer", "undo": "unsplit",
    "skip": "skipsplit", "pause": "pause", "resume": "resume", "reset": "reset",
}


class LiveSplitClient:
    """Polls LiveSplit and keeps the last known state."""

    def __init__(self, host, port):
        self.host = host
        self.port = port
        self.sock = None
        self.connected = False
        self.lock = threading.Lock()
        self.state = {"phase": "idle", "time": 0.0, "currentSplit": 0}

    def connect(self):
        while True:
            try:
                self.sock = socket.create_connection((self.host, self.port), timeout=3)
                self.sock.settimeout(1.0)
                self.connected = True
                print(f"[bridge] connected to LiveSplit at {self.host}:{self.port}")
                return
            except OSError:
                self.connected = False
                time.sleep(2)

    def ask(self, command):
        """Send one command and read one line back."""
        with self.lock:
            if not self.connected:
                return None
            try:
                self.sock.sendall((command + "\r\n").encode())
                data = b""
                while not data.endswith(b"\n"):
                    chunk = self.sock.recv(256)
                    if not chunk:
                        raise OSError("closed")
                    data += chunk
                return data.decode(errors="replace").strip()
            except OSError:
                self.connected = False
                try:
                    self.sock.close()
                except OSError:
                    pass
                threading.Thread(target=self.connect, daemon=True).start()
                return None

    def send(self, command):
        with self.lock:
            if self.connected:
                try:
                    self.sock.sendall((command + "\r\n").encode())
                except OSError:
                    self.connected = False

    def poll(self):
        phase = self.ask("getcurrenttimerphase")
        clock = self.ask("getcurrenttime")
        index = self.ask("getsplitindex")
        if phase is not None:
            self.state["phase"] = {
                "Running": "running", "Paused": "paused", "Ended": "ended",
            }.get(phase, "idle")
        if clock:
            seconds = parse_clock(clock)
            if seconds is not None:
                self.state["time"] = seconds
        if index and index.lstrip("-").isdigit():
            self.state["currentSplit"] = max(0, int(index))
        return dict(self.state)


def parse_clock(text):
    total = 0.0
    try:
        for part in text.strip().split(":"):
            total = total * 60 + float(part)
    except ValueError:
        return None
    return total


# --------------------------------------------------------------- websocket

def handshake(conn, allow_remote, peer):
    request = b""
    while b"\r\n\r\n" not in request:
        chunk = conn.recv(1024)
        if not chunk:
            return False
        request += chunk
        if len(request) > 8192:
            return False
    headers = {}
    for line in request.decode(errors="replace").split("\r\n")[1:]:
        if ": " in line:
            key, value = line.split(": ", 1)
            headers[key.lower()] = value
    key = headers.get("sec-websocket-key")
    if not key:
        conn.sendall(b"HTTP/1.1 400 Bad Request\r\n\r\n")
        return False
    if not allow_remote and not peer.startswith(("127.", "::1")):
        conn.sendall(b"HTTP/1.1 403 Forbidden\r\n\r\n")
        return False
    accept = base64.b64encode(hashlib.sha1(key.encode() + GUID).digest()).decode()
    conn.sendall(
        b"HTTP/1.1 101 Switching Protocols\r\n"
        b"Upgrade: websocket\r\nConnection: Upgrade\r\n"
        b"Sec-WebSocket-Accept: " + accept.encode() + b"\r\n\r\n"
    )
    return True


def encode_frame(payload):
    data = payload.encode()
    header = bytearray([0x81])
    length = len(data)
    if length < 126:
        header.append(length)
    elif length < 1 << 16:
        header.append(126)
        header += struct.pack(">H", length)
    else:
        header.append(127)
        header += struct.pack(">Q", length)
    return bytes(header) + data


def decode_frames(buffer):
    """Yield (opcode, payload) pairs, returning what is left unconsumed."""
    out = []
    while len(buffer) >= 2:
        first, second = buffer[0], buffer[1]
        opcode = first & 0x0F
        masked = second & 0x80
        length = second & 0x7F
        offset = 2
        if length == 126:
            if len(buffer) < 4:
                break
            length = struct.unpack(">H", buffer[2:4])[0]
            offset = 4
        elif length == 127:
            if len(buffer) < 10:
                break
            length = struct.unpack(">Q", buffer[2:10])[0]
            offset = 10
        if masked:
            if len(buffer) < offset + 4:
                break
            mask = buffer[offset:offset + 4]
            offset += 4
        if len(buffer) < offset + length:
            break
        payload = bytearray(buffer[offset:offset + length])
        if masked:
            for i in range(length):
                payload[i] ^= mask[i % 4]
        out.append((opcode, bytes(payload)))
        buffer = buffer[offset + length:]
    return out, buffer


def serve(args):
    client = LiveSplitClient(args.livesplit_host, args.livesplit_port)
    threading.Thread(target=client.connect, daemon=True).start()

    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind((args.bind, args.port))
    listener.listen(8)
    listener.setblocking(False)
    print(f"[bridge] websocket on ws://{args.bind}:{args.port} — point the studio here")

    selector = selectors.DefaultSelector()
    selector.register(listener, selectors.EVENT_READ, "accept")
    clients = {}
    last_poll = 0.0

    while True:
        for key, _ in selector.select(timeout=0.02):
            if key.data == "accept":
                conn, addr = listener.accept()
                conn.settimeout(3)
                try:
                    if handshake(conn, args.allow_remote, addr[0]):
                        conn.setblocking(False)
                        selector.register(conn, selectors.EVENT_READ, "client")
                        clients[conn] = b""
                    else:
                        conn.close()
                except OSError:
                    conn.close()
            else:
                conn = key.fileobj
                try:
                    chunk = conn.recv(4096)
                except OSError:
                    chunk = b""
                if not chunk:
                    selector.unregister(conn)
                    clients.pop(conn, None)
                    conn.close()
                    continue
                frames, clients[conn] = decode_frames(clients[conn] + chunk)
                for opcode, payload in frames:
                    if opcode == 0x8:
                        selector.unregister(conn)
                        clients.pop(conn, None)
                        conn.close()
                        break
                    if opcode != 0x1:
                        continue
                    try:
                        message = json.loads(payload.decode())
                    except ValueError:
                        continue
                    command = COMMANDS.get(message.get("cmd"))
                    if command:
                        client.send(command)

        now = time.time()
        if clients and now - last_poll >= args.interval:
            last_poll = now
            state = client.poll()
            frame = encode_frame(json.dumps({"type": "state", **state}))
            for conn in list(clients):
                try:
                    conn.sendall(frame)
                except OSError:
                    selector.unregister(conn)
                    clients.pop(conn, None)
                    conn.close()


def main():
    parser = argparse.ArgumentParser(description="Bridge LiveSplit Server to a WebSocket")
    parser.add_argument("--port", type=int, default=16835)
    parser.add_argument("--bind", default="127.0.0.1")
    parser.add_argument("--livesplit-host", default="127.0.0.1")
    parser.add_argument("--livesplit-port", type=int, default=16834)
    parser.add_argument("--interval", type=float, default=0.05, help="poll interval in seconds")
    parser.add_argument("--allow-remote", action="store_true", help="accept non-loopback clients")
    serve(parser.parse_args())


if __name__ == "__main__":
    main()
