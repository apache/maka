# Licensed to the Apache Software Foundation (ASF) under one
# or more contributor license agreements.  See the NOTICE file
# distributed with this work for additional information
# regarding copyright ownership.  The ASF licenses this file
# to you under the Apache License, Version 2.0 (the
# "License"); you may not use this file except in compliance
# with the License.  You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing,
# software distributed under the License is distributed on an
# "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
# KIND, either express or implied.  See the License for the
# specific language governing permissions and limitations
# under the License.

"""Prove raw tunnels die on a real mitmproxy 12.2.3 without breaking HTTPS or WebSocket.

Unit tests cannot see addon order: script `next_layer` runs before the built-in
classifier assigns `TCPLayer`. This test starts the pinned proxy image and a
local origin, then asserts what a live cell would observe.

It needs Docker, the pinned proxy image, and `python:3.12-slim`, so it is opt-in:

    MAKA_EVAL_EGRESS_PROXY_TEST=1 python3 harbor/test_egress_filter_live.py
"""

from __future__ import annotations

import base64
import json
import os
import shutil
import socket
import ssl
import subprocess
import tempfile
import time
import unittest
import uuid
from pathlib import Path

HARBOR_DIR = Path(__file__).parent
PROXY_IMAGE = "maka-eval-egress-proxy:12.2.3"
ORIGIN_IMAGE = "python:3.12-slim"
COMMAND_TIMEOUT_S = 60
CLOSE_TIMEOUT_S = 2.0

ORIGIN_SCRIPT = r"""
import base64, hashlib, json, socket, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

stats = {"raw_recv": 0, "raw_closed": 0, "upgrade_recv": 0, "upgrade_closed": 0}

class HttpHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/plain")
        self.end_headers()
        self.wfile.write(b"http-ok")
    def log_message(self, format, *args):
        return

class WsHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.headers.get("Upgrade", "").lower() != "websocket":
            self.send_error(400)
            return
        key = self.headers.get("Sec-WebSocket-Key", "")
        accept = base64.b64encode(
            hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()
        ).decode()
        self.send_response(101, "Switching Protocols")
        self.send_header("Upgrade", "websocket")
        self.send_header("Connection", "Upgrade")
        self.send_header("Sec-WebSocket-Accept", accept)
        self.end_headers()
        payload = b"ws-ok"
        self.wfile.write(bytes([0x81, len(payload)]) + payload)
        self.wfile.flush()
    def log_message(self, format, *args):
        return

class UpgradeHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(101, "Switching Protocols")
        self.send_header("Upgrade", "raw")
        self.send_header("Connection", "Upgrade")
        self.end_headers()
        self.wfile.write(b"UPGRADE-BANNER\n")
        self.wfile.flush()
        self.connection.settimeout(60)
        try:
            while True:
                chunk = self.connection.recv(64)
                if not chunk:
                    break
                stats["upgrade_recv"] += len(chunk)
        except OSError:
            pass
        finally:
            stats["upgrade_closed"] += 1
    def log_message(self, format, *args):
        return

def serve_raw():
    sock = socket.socket()
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind(("0.0.0.0", 19081))
    sock.listen(8)
    while True:
        conn, _ = sock.accept()
        try:
            conn.sendall(b"RAW-BANNER\n")
            conn.settimeout(60)
            while True:
                chunk = conn.recv(64)
                if not chunk:
                    break
                stats["raw_recv"] += len(chunk)
        except OSError:
            pass
        finally:
            stats["raw_closed"] += 1
            conn.close()

class StatsHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        body = json.dumps(stats).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, format, *args):
        return

threading.Thread(target=serve_raw, daemon=True).start()
threading.Thread(target=lambda: ThreadingHTTPServer(("0.0.0.0", 19080), HttpHandler).serve_forever(), daemon=True).start()
threading.Thread(target=lambda: ThreadingHTTPServer(("0.0.0.0", 19082), WsHandler).serve_forever(), daemon=True).start()
threading.Thread(target=lambda: ThreadingHTTPServer(("0.0.0.0", 19083), UpgradeHandler).serve_forever(), daemon=True).start()
ThreadingHTTPServer(("0.0.0.0", 19084), StatsHandler).serve_forever()
"""


def docker_available() -> bool:
    if shutil.which("docker") is None:
        return False
    probe = subprocess.run(
        ["docker", "version", "--format", "{{.Server.Version}}"],
        capture_output=True,
        timeout=COMMAND_TIMEOUT_S,
    )
    return probe.returncode == 0


def docker_image_present(image: str) -> bool:
    inspect = subprocess.run(
        ["docker", "image", "inspect", image],
        capture_output=True,
        timeout=COMMAND_TIMEOUT_S,
    )
    return inspect.returncode == 0


def finish_memory_bio_handshake(tls, incoming, outgoing, sock, timeout_s: float) -> str:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        try:
            tls.do_handshake()
        except ssl.SSLWantReadError:
            # Processing a server flight can produce the next client flight
            # before OpenSSL asks for more input. Flush it now; waiting for
            # another recv first deadlocks both peers.
            pending = outgoing.read()
            if pending:
                sock.sendall(pending)
            response = sock.recv(16 * 1024)
            if not response:
                raise AssertionError("proxy closed during the fragmented TLS handshake")
            incoming.write(response)
            continue
        pending = outgoing.read()
        if pending:
            sock.sendall(pending)
        return tls.version() or ""
    raise AssertionError("fragmented TLS handshake did not complete")


class MemoryBioHandshakeDriverTest(unittest.TestCase):
    def test_flushes_client_flight_before_waiting_for_more_server_bytes(self) -> None:
        events = []

        class FakeOutgoing:
            pending = b""

            def read(self):
                pending, self.pending = self.pending, b""
                return pending

        class FakeIncoming:
            def write(self, data):
                events.append(("write", data))

        outgoing = FakeOutgoing()

        class FakeTls:
            calls = 0

            def do_handshake(self):
                self.calls += 1
                if self.calls == 1:
                    outgoing.pending = b"client-finished"
                    raise ssl.SSLWantReadError()

            def version(self):
                return "TLSv1.3"

        class FakeSocket:
            def sendall(self, data):
                events.append(("send", data))

            def recv(self, _size):
                events.append(("recv", None))
                return b"server-finished"

        result = finish_memory_bio_handshake(
            FakeTls(), FakeIncoming(), outgoing, FakeSocket(), timeout_s=1
        )

        self.assertEqual(result, "TLSv1.3")
        self.assertEqual(
            events,
            [
                ("send", b"client-finished"),
                ("recv", None),
                ("write", b"server-finished"),
            ],
        )


@unittest.skipUnless(
    os.environ.get("MAKA_EVAL_EGRESS_PROXY_TEST") == "1",
    "set MAKA_EVAL_EGRESS_PROXY_TEST=1 to run the live mitmproxy proxy test",
)
class LiveEgressFilterTest(unittest.TestCase):
    workdir: Path | None = None
    network: str = ""
    proxy: str = ""
    origin: str = ""
    proxy_port: int = 0

    @classmethod
    def setUpClass(cls) -> None:
        if not docker_available():
            raise unittest.SkipTest("Docker daemon is unavailable")
        if not docker_image_present(PROXY_IMAGE):
            raise unittest.SkipTest(f"{PROXY_IMAGE} is not present")
        if not docker_image_present(ORIGIN_IMAGE):
            raise unittest.SkipTest(f"{ORIGIN_IMAGE} is not present")
        run_id = f"{os.getpid()}-{uuid.uuid4().hex[:8]}"
        cls.network = f"maka-eval-egress-live-{run_id}-net"
        cls.proxy = f"maka-eval-egress-live-{run_id}-proxy"
        cls.origin = f"maka-eval-egress-live-{run_id}-origin"
        cls.workdir = Path(tempfile.mkdtemp(prefix="maka-eval-egress-proxy-live-"))
        (cls.workdir / "origin.py").write_text(ORIGIN_SCRIPT)
        cls.addClassCleanup(shutil.rmtree, cls.workdir, ignore_errors=True)
        cls.addClassCleanup(cls._down)
        subprocess.run(["docker", "network", "create", cls.network], check=True, timeout=COMMAND_TIMEOUT_S)
        subprocess.run(
            [
                "docker",
                "run",
                "-d",
                "--name",
                cls.origin,
                "--network",
                cls.network,
                "--network-alias",
                "origin",
                "-v",
                f"{cls.workdir / 'origin.py'}:/origin.py:ro",
                ORIGIN_IMAGE,
                "python",
                "/origin.py",
            ],
            check=True,
            timeout=COMMAND_TIMEOUT_S,
        )
        subprocess.run(
            [
                "docker",
                "run",
                "-d",
                "--name",
                cls.proxy,
                "--network",
                cls.network,
                "-p",
                "127.0.0.1::8080",
                "-v",
                f"{HARBOR_DIR / 'egress_filter.py'}:/opt/maka-eval/egress_filter.py:ro",
                PROXY_IMAGE,
            ],
            check=True,
            timeout=COMMAND_TIMEOUT_S,
        )
        cls.proxy_port = cls._published_port()
        cls._wait_for_proxy()
        cls._wait_for_origin_via_proxy()

    @classmethod
    def _published_port(cls) -> int:
        listed = subprocess.run(
            ["docker", "port", cls.proxy, "8080/tcp"],
            capture_output=True,
            text=True,
            timeout=COMMAND_TIMEOUT_S,
        )
        if listed.returncode != 0:
            raise AssertionError(listed.stderr)
        # "127.0.0.1:49152"
        hostport = listed.stdout.strip().splitlines()[0]
        return int(hostport.rsplit(":", 1)[1])

    @classmethod
    def _down(cls) -> None:
        for name in (cls.proxy, cls.origin):
            if not name:
                continue
            subprocess.run(
                ["docker", "rm", "-f", name],
                capture_output=True,
                timeout=COMMAND_TIMEOUT_S,
            )
        if cls.network:
            subprocess.run(
                ["docker", "network", "rm", cls.network],
                capture_output=True,
                timeout=COMMAND_TIMEOUT_S,
            )

    @classmethod
    def _wait_for_proxy(cls) -> None:
        deadline = time.time() + 30
        last_error = "proxy did not listen"
        while time.time() < deadline:
            try:
                with socket.create_connection(("127.0.0.1", cls.proxy_port), 1):
                    return
            except OSError as error:
                last_error = str(error)
                time.sleep(0.2)
        raise AssertionError(last_error)

    @classmethod
    def _wait_for_origin_via_proxy(cls) -> None:
        deadline = time.time() + 30
        last_error = "origin was not reachable through the proxy"
        while time.time() < deadline:
            try:
                body = cls.http_via_proxy(19080)
            except OSError as error:
                last_error = str(error)
                time.sleep(0.2)
                continue
            if b"http-ok" in body:
                return
            last_error = body[:200].decode("latin1", errors="replace")
            time.sleep(0.2)
        raise AssertionError(last_error)

    @classmethod
    def _recv_until_close(cls, sock: socket.socket, limit: int = 8192) -> bytes:
        sock.settimeout(CLOSE_TIMEOUT_S)
        data = b""
        while len(data) < limit:
            try:
                chunk = sock.recv(4096)
            except ConnectionResetError:
                return data
            if not chunk:
                return data
            data += chunk
        return data

    @classmethod
    def http_via_proxy(
        cls,
        port: int,
        extra_headers: str = "",
        connection: str = "close",
    ) -> bytes:
        request = (
            f"GET http://origin:{port}/ HTTP/1.1\r\n"
            f"Host: origin:{port}\r\n"
            f"{extra_headers}"
            f"Connection: {connection}\r\n\r\n"
        ).encode()
        with socket.create_connection(("127.0.0.1", cls.proxy_port), 5) as sock:
            sock.sendall(request)
            return cls._recv_until_close(sock)

    @classmethod
    def connect_via_proxy(cls, host: str, port: int, payload: bytes = b"CLIENT\n") -> tuple[bytes, bytes]:
        with socket.create_connection(("127.0.0.1", cls.proxy_port), 5) as sock:
            sock.sendall(f"CONNECT {host}:{port} HTTP/1.1\r\nHost: {host}:{port}\r\n\r\n".encode())
            header = b""
            sock.settimeout(CLOSE_TIMEOUT_S)
            while b"\r\n\r\n" not in header:
                chunk = sock.recv(4096)
                if not chunk:
                    return header, b""
                header += chunk
            leftover = header.split(b"\r\n\r\n", 1)[1]
            header = header[: header.index(b"\r\n\r\n") + 4]
            if not payload:
                return header, leftover
            try:
                sock.sendall(payload)
            except OSError:
                return header, leftover
            return header, leftover + cls._recv_until_close(sock)

    @classmethod
    def fragmented_tls_via_proxy(cls, first_fragment_size: int) -> str:
        incoming = ssl.MemoryBIO()
        outgoing = ssl.MemoryBIO()
        tls_context = ssl.create_default_context()
        # The proxy image creates an ephemeral private CA. This test exercises
        # protocol classification and the handshake, not CA distribution.
        tls_context.check_hostname = False
        tls_context.verify_mode = ssl.CERT_NONE
        tls = tls_context.wrap_bio(
            incoming,
            outgoing,
            server_side=False,
            server_hostname="example.com",
        )
        try:
            tls.do_handshake()
        except ssl.SSLWantReadError:
            pass
        client_hello = outgoing.read()
        if len(client_hello) <= first_fragment_size:
            raise AssertionError("TLS ClientHello was unexpectedly short")

        with socket.create_connection(("127.0.0.1", cls.proxy_port), 5) as sock:
            sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            sock.sendall(b"CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n")
            header = b""
            while b"\r\n\r\n" not in header:
                chunk = sock.recv(4096)
                if not chunk:
                    raise AssertionError("proxy closed before the CONNECT response")
                header += chunk
            if b" 200 " not in header.split(b"\r\n", 1)[0]:
                raise AssertionError(header.decode("latin1", errors="replace"))

            sock.sendall(client_hello[:first_fragment_size])
            time.sleep(0.05)
            sock.sendall(client_hello[first_fragment_size:])
            sock.settimeout(10)
            return finish_memory_bio_handshake(tls, incoming, outgoing, sock, timeout_s=20)

    @classmethod
    def audit_records(cls) -> list[dict[str, object]]:
        listed = subprocess.run(
            [
                "docker",
                "exec",
                cls.proxy,
                "sh",
                "-c",
                "if [ -f /opt/maka-egress-state/hits.jsonl ]; then cat /opt/maka-egress-state/hits.jsonl; fi",
            ],
            capture_output=True,
            text=True,
            timeout=COMMAND_TIMEOUT_S,
        )
        if listed.returncode != 0:
            raise AssertionError(listed.stderr)
        return [json.loads(line) for line in listed.stdout.splitlines() if line.strip()]

    @classmethod
    def origin_stats(cls) -> dict[str, int]:
        # Read stats from inside the origin container so the probe does not
        # depend on the proxy remaining willing to forward that port.
        listed = subprocess.run(
            [
                "docker",
                "exec",
                cls.origin,
                "python",
                "-c",
                "import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:19084/').read().decode())",
            ],
            capture_output=True,
            text=True,
            timeout=COMMAND_TIMEOUT_S,
        )
        if listed.returncode != 0:
            raise AssertionError(listed.stderr)
        return json.loads(listed.stdout)

    @classmethod
    def wait_for_origin_counter(cls, key: str, minimum: int) -> dict[str, int]:
        deadline = time.time() + CLOSE_TIMEOUT_S
        last = cls.origin_stats()
        while time.time() < deadline:
            if last.get(key, 0) >= minimum:
                return last
            time.sleep(0.05)
            last = cls.origin_stats()
        raise AssertionError(f"origin counter {key} did not reach {minimum}: {last}")

    def test_https_and_plain_http_still_forward(self) -> None:
        http = self.http_via_proxy(19080)
        self.assertIn(b"http-ok", http)
        curl = subprocess.run(
            [
                "curl",
                "--silent",
                "--show-error",
                "--http1.1",
                "--max-time",
                "20",
                "--proxy",
                f"http://127.0.0.1:{self.proxy_port}",
                "--insecure",
                "--output",
                "/dev/null",
                "--write-out",
                "%{http_code}",
                "https://example.com/",
            ],
            capture_output=True,
            text=True,
            timeout=COMMAND_TIMEOUT_S,
        )
        self.assertEqual(curl.stdout, "200", curl.stderr)

    def test_fragmented_tls_record_prefix_still_handshakes(self) -> None:
        # Three bytes are sufficient for mitmproxy's built-in TLS classifier
        # and provide a control for the one- and two-byte fragmented prefixes.
        for first_fragment_size in (1, 2, 3):
            with self.subTest(first_fragment_size=first_fragment_size):
                self.assertTrue(
                    self.fragmented_tls_via_proxy(first_fragment_size).startswith("TLS")
                )

    def test_connect_to_a_blocklisted_host_is_451(self) -> None:
        header, _ = self.connect_via_proxy("tbench.ai", 443, b"")
        self.assertIn(b"451", header.split(b"\r\n", 1)[0])
        self.assertIn(b"tbench_domain", header)

    def test_raw_connect_relays_no_bytes_and_is_audited(self) -> None:
        closed_before = self.origin_stats()["raw_closed"]
        header, body = self.connect_via_proxy("origin", 19081)
        self.assertIn(b"200", header.split(b"\r\n", 1)[0])
        self.assertNotIn(b"RAW-BANNER", body)
        self.assertEqual(body, b"")
        stats = self.wait_for_origin_counter("raw_closed", closed_before + 1)
        self.assertEqual(stats["raw_recv"], 0)
        self.assertIn(
            {"host": "origin", "normalizedPath": ":19081", "ruleId": "raw_tunnel"},
            [{key: record.get(key) for key in ("host", "normalizedPath", "ruleId")} for record in self.audit_records()],
        )

    def test_http_101_raw_upgrade_is_audited_without_relaying_the_banner(self) -> None:
        closed_before = self.origin_stats()["upgrade_closed"]
        data = self.http_via_proxy(
            19083,
            extra_headers="Upgrade: raw\r\n",
            connection="Upgrade",
        )
        self.assertIn(b"101", data.split(b"\r\n", 1)[0])
        self.assertNotIn(b"UPGRADE-BANNER", data)
        stats = self.wait_for_origin_counter("upgrade_closed", closed_before + 1)
        self.assertEqual(stats["upgrade_recv"], 0)
        self.assertIn(
            {"host": "origin", "normalizedPath": ":19083", "ruleId": "raw_tunnel"},
            [{key: record.get(key) for key in ("host", "normalizedPath", "ruleId")} for record in self.audit_records()],
        )

    def test_websocket_upgrade_still_completes(self) -> None:
        key = base64.b64encode(b"0123456789abcdef").decode()
        data = self.http_via_proxy(
            19082,
            extra_headers=(
                "Upgrade: websocket\r\n"
                f"Sec-WebSocket-Key: {key}\r\n"
                "Sec-WebSocket-Version: 13\r\n"
            ),
            connection="Upgrade",
        )
        self.assertIn(b"101", data.split(b"\r\n", 1)[0])
        self.assertIn(b"ws-ok", data)
        self.assertNotIn(
            ":19082",
            [str(record.get("normalizedPath")) for record in self.audit_records()],
        )


if __name__ == "__main__":
    unittest.main()
