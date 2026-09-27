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

"""Fail-closed URL contamination filter for Eval subject egress."""

from __future__ import annotations

import json
import os
import re
import time
from contextlib import suppress
from ipaddress import IPv6Address
from pathlib import Path
from typing import NamedTuple
from urllib.parse import unquote, urlsplit

PINNED_REVISION = "d49e28f1e4ddd13d289e85a5f312a66750951932"
MAX_DECODE_PASSES = 4
MAX_AUDIT_BYTES = 1024 * 1024
AUDIT_PATH = Path(
    os.environ.get("MAKA_EVAL_EGRESS_AUDIT", "/opt/maka-egress-state/hits.jsonl")
)
PERCENT_ESCAPE = re.compile(r"%(?![0-9a-fA-F]{2})")
TERMINAL_BENCH = re.compile(r"terminal[-_.%/+\s]*bench", re.IGNORECASE)


class ConnectTarget(NamedTuple):
    """Validated CONNECT authority adapted into the URL policy's input shape."""

    host: str
    port: int | None
    url: str


def contamination_rule(raw_url: str) -> tuple[str, str, str] | None:
    normalized = normalize_url(raw_url)
    url = urlsplit(normalized)
    host = (url.hostname or "").lower().rstrip(".")
    path_query = f"{url.path}?{url.query}" if url.query else url.path
    lowered = path_query.lower()

    # Search the host and the path separately. A benchmark name in the hostname
    # is a contamination surface, and searching the two fields joined would let
    # a rule match across their boundary.
    def anywhere(needle: str) -> bool:
        return needle in host or needle in lowered

    if host == "r.jina.ai":
        inner = unquote(url.path.lstrip("/"))
        if inner.startswith(("http://", "https://")):
            nested = contamination_rule(inner)
            if nested:
                return (f"jina_recursive:{nested[0]}", host, path_query)

    if anywhere(PINNED_REVISION):
        return ("pinned_revision", host, path_query)
    if host == "tbench.ai" or host.endswith(".tbench.ai"):
        return ("tbench_domain", host, path_query)
    if host == "hub.harborframework.com" and "/tasks/terminal-bench" in lowered:
        return ("harbor_task_registry", host, path_query)
    if benchmark_repository(host, lowered):
        return ("benchmark_repository", host, path_query)
    if public_trajectory_repository(host, lowered):
        return ("public_trajectory", host, path_query)
    if anywhere("patches-terminalbench-"):
        return ("known_patch_artifact", host, path_query)
    if TERMINAL_BENCH.search(host) or TERMINAL_BENCH.search(lowered):
        return ("terminal_bench_url", host, path_query)
    return None


def normalize_url(raw_url: str) -> str:
    value = raw_url.strip()
    if not value:
        raise ValueError("empty URL")
    for _ in range(MAX_DECODE_PASSES):
        if PERCENT_ESCAPE.search(value):
            raise ValueError("malformed percent escape")
        decoded = unquote(value)
        if decoded == value:
            break
        value = decoded
    else:
        raise ValueError("URL exceeded decode limit")
    parsed = urlsplit(value)
    if parsed.scheme.lower() not in {"http", "https"} or not parsed.hostname:
        raise ValueError("unsupported URL")
    return value


def benchmark_repository(host: str, path_query: str) -> bool:
    repositories = (
        "harbor-framework/terminal-bench",
        "terminal-benchmarks/terminal-bench",
        "tbench-ai/terminal-bench",
    )
    return host in {
        "github.com",
        "api.github.com",
        "raw.githubusercontent.com",
        "codeload.github.com",
    } and any(repository in path_query for repository in repositories)


def public_trajectory_repository(host: str, path_query: str) -> bool:
    return (
        host in {"github.com", "api.github.com", "raw.githubusercontent.com", "huggingface.co"}
        and "hqeric/maka-eval-trajectories" in path_query
    )


try:
    from mitmproxy import http
except ImportError:
    http = None

try:
    from mitmproxy.proxy import commands as proxy_commands
    from mitmproxy.proxy.layer import Layer
    from mitmproxy.proxy.layers import ClientTLSLayer, ServerTLSLayer
    from mitmproxy.proxy.layers.tcp import TCPLayer
except ImportError:
    proxy_commands = None
    Layer = object
    ClientTLSLayer = None
    ServerTLSLayer = None
    TCPLayer = None

try:
    from mitmproxy.net.tls import starts_like_tls_record
except ImportError:
    def starts_like_tls_record(data: bytes) -> bool:
        return len(data) >= 3 and data[0] == 0x16 and data[1] == 0x03


def configure(updated: object) -> None:
    # HTTP 101 upgrades construct TCPLayer inside the HTTP layer without
    # another next_layer hook. rawtcp=false makes that path CloseConnection
    # itself; WebSocket upgrades stay on the websocket layer.
    try:
        from mitmproxy import ctx
    except ImportError:
        return
    if getattr(ctx.options, "rawtcp", False):
        ctx.options.rawtcp = False


def request(flow: object) -> None:
    enforce_url_policy(flow, flow.request.pretty_url)


def response(flow: object) -> None:
    reply = getattr(flow, "response", None)
    if getattr(reply, "status_code", None) != 101:
        return
    # mitmproxy 12.2.3 sets flow.websocket before HttpResponseHook only when
    # the 101 is a real WebSocket upgrade (Upgrade + version 13 + option on).
    # A websocket Upgrade header alone still falls through to CloseConnection
    # under rawtcp=false and must be audited.
    if getattr(flow, "websocket", None) is not None:
        return
    reject_raw_transport(flow, close=False)


def http_connect(flow: object) -> None:
    request = getattr(flow, "request", None)
    try:
        target = parse_connect_target(
            getattr(request, "host", None),
            getattr(request, "port", None),
        ).url
    except (TypeError, ValueError):
        target = ""
    enforce_url_policy(flow, target)


def tcp_start(flow: object) -> None:
    # This is a last-resort hook for a raw layer admitted by an override.
    reject_raw_transport(flow)


def tcp_message(flow: object) -> None:
    messages = getattr(flow, "messages", None)
    if messages and hasattr(messages[-1], "content"):
        messages[-1].content = b""
    close_flow(flow)


def next_layer(nextlayer: object) -> None:
    current = getattr(nextlayer, "layer", None)
    context = getattr(nextlayer, "context", None)
    if current is None:
        data_client = _next_layer_bytes(nextlayer, "data_client")
        if _is_fragmented_tls_record_prefix(data_client):
            if ClientTLSLayer is None or ServerTLSLayer is None:
                return
            server_tls = ServerTLSLayer(context)
            server_tls.child_layer = ClientTLSLayer(context)
            nextlayer.layer = server_tls
            return
        if not initial_stream_is_raw(nextlayer):
            return
        reject_raw_transport(context, close=False)
        nextlayer.layer = RejectRawTransport(context, proxy_commands)
        return
    if TCPLayer is None or not isinstance(current, TCPLayer):
        return
    reject_raw_transport(context, close=False)
    closer = RejectRawTransport(context, proxy_commands)
    replace_layer(context, current, closer)
    nextlayer.layer = closer


def enforce_url_policy(flow: object, raw_url: str) -> None:
    if http is None:
        raise RuntimeError("mitmproxy is required to run the Eval egress filter")
    try:
        matched = contamination_rule(raw_url)
        if not matched:
            return
        rule_id, host, normalized_path = matched
        audit_event(rule_id, host, normalized_path)
        flow.response = blocked_response(rule_id)
    except Exception as error:
        flow.response = http.Response.make(
            503,
            b"Eval egress policy could not classify this request.\n",
            {
                "Content-Type": "text/plain; charset=utf-8",
                "X-Maka-Eval-Egress-Rule": "policy_error",
            },
        )
        try:
            audit_event("policy_error", "", type(error).__name__)
        except Exception:
            pass


def connect_url(host: object, port: object) -> str:
    return parse_connect_target(host, port).url


def parse_connect_target(host: object, port: object) -> ConnectTarget:
    normalized_host = _normalize_connect_host(host)
    normalized_port = _normalize_connect_port(port)
    scheme = "http" if normalized_port == 80 else "https"
    authority = normalized_host if normalized_port in (None, 443, 80) else f"{normalized_host}:{normalized_port}"
    return ConnectTarget(
        host=normalized_host,
        port=normalized_port,
        url=f"{scheme}://{authority}/",
    )


def _normalize_connect_host(host: object) -> str:
    if not isinstance(host, str) or not host or host != host.strip():
        raise ValueError("empty CONNECT host")
    if host.startswith("[") and host.endswith("]"):
        IPv6Address(host[1:-1])
        return host
    if ":" in host:
        IPv6Address(host)
        return f"[{host}]"
    if re.search(r"[\s/@?#\\\[\]]", host):
        raise ValueError("invalid CONNECT host")
    return host


def _normalize_connect_port(port: object) -> int | None:
    if port is None:
        return None
    if type(port) is not int or not 1 <= port <= 65535:
        raise ValueError("invalid CONNECT port")
    return port


def initial_stream_is_raw(nextlayer: object) -> bool:
    """Close only when the bytes cannot still become HTTP or TLS.

    Script next_layer runs before mitmproxy 12.2.3's classifier. Copying its
    `probably_no_http` test here would treat `GET` / `GET ` as raw and assign
    CloseRawLayer while the request line is still arriving. With rawtcp=false
    the built-in path would have kept waiting for HttpLayer.
    """
    data_client = _next_layer_bytes(nextlayer, "data_client")
    data_server = _next_layer_bytes(nextlayer, "data_server")
    if _could_start_tls_record(data_client):
        return False
    if not data_client and not data_server:
        return False
    if data_server or data_client.startswith(b"SSH"):
        return True
    return not _still_could_be_http(data_client)


def _could_start_tls_record(data: bytes) -> bool:
    """Keep a fragmented ClientHello undecided until its 3-byte prefix exists."""
    if starts_like_tls_record(data):
        return True
    return _is_fragmented_tls_record_prefix(data)


def _is_fragmented_tls_record_prefix(data: bytes) -> bool:
    return 0 < len(data) < 3 and b"\x16\x03".startswith(data)


def _still_could_be_http(data: bytes) -> bool:
    first_line, newline, _rest = data.partition(b"\n")
    line = first_line.rstrip(b"\r")
    method, space, _remainder = line.partition(b" ")
    if not method.isascii() or not method.isalpha():
        return False
    if newline and not space:
        return False
    return True


def _next_layer_bytes(nextlayer: object, name: str) -> bytes:
    getter = getattr(nextlayer, name, None)
    if not callable(getter):
        return b""
    try:
        data = getter()
    except Exception:
        return b""
    return bytes(data) if isinstance(data, (bytes, bytearray)) else b""


def peer_label(owner: object) -> tuple[str, str]:
    server = getattr(owner, "server_conn", None) or getattr(owner, "server", None)
    address = getattr(server, "address", None)
    if isinstance(address, (tuple, list)) and address:
        host = str(address[0])[:255]
        port = address[1] if len(address) > 1 else ""
        return host, f":{port}" if port != "" else ""
    return "", ""


def reject_raw_transport(owner: object, *, close: bool = True) -> None:
    host, port = peer_label(owner)
    try:
        audit_event("raw_tunnel", host, port)
    except Exception:
        pass
    if close:
        close_flow(owner)


def close_flow(flow: object) -> None:
    terminate = getattr(flow, "kill", None)
    if callable(terminate) and getattr(flow, "killable", True):
        try:
            terminate()
        except Exception:
            pass


def replace_layer(context: object, current: object, closer: object) -> None:
    layers = getattr(context, "layers", None)
    if not isinstance(layers, list):
        return
    try:
        index = layers.index(current)
    except ValueError:
        index = len(layers)
    if closer in layers:
        layers.remove(closer)
    if current in layers:
        layers.remove(current)
    layers.insert(min(index, len(layers)), closer)


class RejectRawTransport(Layer):
    def __init__(self, context: object, commands: object) -> None:
        self._close_connection = getattr(commands, "CloseConnection", None)
        if Layer is object:
            self.context = context
            return
        if getattr(context, "layers", None) is None:
            context.layers = []
        if getattr(context, "options", None) is None:
            context.options = type("Options", (), {"proxy_debug": False})()
        super().__init__(context)

    def handle_event(self, event: object):
        if self._close_connection is None:
            return
            yield
        for name in ("client", "server"):
            connection = getattr(self.context, name, None)
            if connection is not None:
                yield self._close_connection(connection)


def blocked_response(rule_id: str):
    return http.Response.make(
        451,
        b"Benchmark source or public solution access is blocked during evaluation.\n",
        {
            "Content-Type": "text/plain; charset=utf-8",
            "X-Maka-Eval-Egress-Rule": rule_id,
        },
    )


class AuditJournal:
    def __init__(self, path: Path, byte_limit: int) -> None:
        self.path = path
        self.byte_limit = byte_limit

    def record(self, rule_id: str, host: str, normalized_path: str) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        entry = self._encode(rule_id, host[:255], normalized_path[:4096])
        existing_bytes = self.path.stat().st_size if self.path.exists() else 0
        if existing_bytes + len(entry) <= self.byte_limit:
            with self.path.open("ab") as stream:
                stream.write(entry)
            return
        self.mark_full()

    def mark_full(self) -> None:
        if self.has_full_marker():
            return
        with self.path.open("ab") as stream:
            stream.write(self._separator() + self._encode("audit_truncated", "", ""))

    def has_full_marker(self) -> bool:
        last = self._last_record()
        return last is not None and last.get("ruleId") == "audit_truncated"

    def _separator(self) -> bytes:
        if not self.path.exists() or self.path.stat().st_size == 0:
            return b""
        final_offset = self.path.stat().st_size - 1
        with self.path.open("rb") as stream:
            stream.seek(final_offset)
            return b"" if stream.read(1) == b"\n" else b"\n"

    def _last_record(self) -> dict[str, object] | None:
        if not self.path.exists() or self.path.stat().st_size == 0:
            return None
        size = self.path.stat().st_size
        with self.path.open("rb") as stream:
            stream.seek(max(0, size - 4096))
            lines = stream.read().decode("utf-8", errors="ignore").splitlines()
        for line in reversed(lines):
            if not line.strip():
                continue
            decoded = None
            with suppress(json.JSONDecodeError):
                decoded = json.loads(line)
            return decoded if isinstance(decoded, dict) else None
        return None

    @staticmethod
    def _encode(rule_id: str, host: str, normalized_path: str) -> bytes:
        record = {
            "ts": int(time.time() * 1000),
            "ruleId": rule_id,
            "host": host,
            "normalizedPath": normalized_path,
        }
        return (json.dumps(record, ensure_ascii=True, separators=(",", ":")) + "\n").encode(
            "utf-8"
        )


def audit_event(rule_id: str, host: str, normalized_path: str) -> None:
    AuditJournal(AUDIT_PATH, MAX_AUDIT_BYTES).record(rule_id, host, normalized_path)
