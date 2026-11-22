#!/usr/bin/env python3
"""Local-only TCP and RFC 6455 echo peers for the Gallery standard API demo."""

import base64
import hashlib
import socketserver
import struct
import threading


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


class TcpEcho(socketserver.StreamRequestHandler):
    def handle(self):
        while data := self.rfile.read1(65536):
            self.wfile.write(data)
            self.wfile.flush()


class WebSocketEcho(socketserver.StreamRequestHandler):
    def read_exact(self, size):
        data = self.rfile.read(size)
        if len(data) != size:
            raise EOFError
        return data

    def frame(self, opcode, payload):
        length = len(payload)
        if length < 126:
            header = bytes([0x80 | opcode, length])
        elif length <= 65535:
            header = bytes([0x80 | opcode, 126]) + struct.pack("!H", length)
        else:
            header = bytes([0x80 | opcode, 127]) + struct.pack("!Q", length)
        self.wfile.write(header + payload)
        self.wfile.flush()

    def handle(self):
        self.connection.settimeout(15)
        try:
            request = self.rfile.readline(8192)
            if not request.startswith(b"GET "):
                return
            headers = {}
            for _ in range(100):
                line = self.rfile.readline(8192)
                if line == b"\r\n":
                    break
                key, _, value = line.partition(b":")
                headers[key.strip().lower()] = value.strip()
            else:
                return
            key = headers.get(b"sec-websocket-key")
            if not key:
                return
            accept = base64.b64encode(hashlib.sha1(
                key + b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
            ).digest())
            self.wfile.write(b"HTTP/1.1 101 Switching Protocols\r\n"
                             b"Upgrade: websocket\r\nConnection: Upgrade\r\n"
                             b"Sec-WebSocket-Accept: " + accept + b"\r\n\r\n")
            self.wfile.flush()
            while True:
                first, second = self.read_exact(2)
                length = second & 127
                if length == 126:
                    length = struct.unpack("!H", self.read_exact(2))[0]
                elif length == 127:
                    length = struct.unpack("!Q", self.read_exact(8))[0]
                # The demo sends one small unfragmented, masked message at a time.
                if not first & 128 or not second & 128 or length > 1024 * 1024:
                    self.frame(8, struct.pack("!H", 1002))
                    return
                mask = self.read_exact(4)
                payload = bytes(value ^ mask[i % 4] for i, value in enumerate(self.read_exact(length)))
                opcode = first & 15
                if opcode == 8:
                    self.frame(8, payload)
                    return
                if opcode in (1, 2):
                    self.frame(opcode, payload)
                elif opcode == 9:
                    self.frame(10, payload)
        except (EOFError, OSError):
            pass


def main():
    with Server(("127.0.0.1", 9876), TcpEcho) as tcp, Server(("127.0.0.1", 9877), WebSocketEcho) as ws:
        threading.Thread(target=tcp.serve_forever, daemon=True).start()
        threading.Thread(target=ws.serve_forever, daemon=True).start()
        print("Gallery echo peers: TCP 127.0.0.1:9876; WebSocket ws://127.0.0.1:9877/", flush=True)
        try:
            threading.Event().wait()
        except KeyboardInterrupt:
            tcp.shutdown()
            ws.shutdown()


if __name__ == "__main__":
    main()
