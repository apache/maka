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
from pathlib import Path
from urllib.parse import unquote, urlsplit

PINNED_REVISION = "d49e28f1e4ddd13d289e85a5f312a66750951932"
MAX_DECODE_PASSES = 4
MAX_AUDIT_BYTES = 1024 * 1024
AUDIT_PATH = Path(
    os.environ.get("MAKA_EVAL_EGRESS_AUDIT", "/opt/maka-egress-state/hits.jsonl")
)
PERCENT_ESCAPE = re.compile(r"%(?![0-9a-fA-F]{2})")
TERMINAL_BENCH = re.compile(r"terminal[-_.%/+\s]*bench", re.IGNORECASE)


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
    apply_http_policy(flow, flow.request.pretty_url)


def response(flow: object) -> None:
    response = getattr(flow, "response", None)
    if getattr(response, "status_code", None) != 101:
        return
    # mitmproxy 12.2.3 sets flow.websocket before HttpResponseHook only when
    # the 101 is a real WebSocket upgrade (Upgrade + version 13 + option on).
    # A websocket Upgrade header alone still falls through to CloseConnection
    # under rawtcp=false and must be audited.
    if getattr(flow, "websocket", None) is not None:
        return
    record_raw_tunnel(flow)


def http_connect(flow: object) -> None:
    try:
        raw_url = connect_target_url(flow)
    except Exception:
        raw_url = ""
    apply_http_policy(flow, raw_url)


def tcp_start(flow: object) -> None:
    # Last resort if a TCPLayer is still admitted (tcp_hosts / ignore).
    # CONNECT raw is closed by next_layer → CloseRawLayer; HTTP 101 raw is
    # closed by rawtcp=false. Neither of those paths starts a TCPLayer.
    record_raw_tunnel(flow)
    kill_flow(flow)


def tcp_message(flow: object) -> None:
    messages = getattr(flow, "messages", None)
    if messages:
        messages[-1].content = b""
    kill_flow(flow)


def next_layer(nextlayer: object) -> None:
    # Script addons run before the built-in classifier assigns layer. If we
    # set CloseRawLayer here, NextLayer leaves it in place. Waiting for
    # isinstance(..., TCPLayer) never fires on the production CONNECT path.
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
        if not looks_like_raw_tcp(nextlayer):
            return
        record_raw_tunnel(context)
        nextlayer.layer = CloseRawLayer(context)
        return
    if TCPLayer is None or not isinstance(current, TCPLayer):
        return
    record_raw_tunnel(context)
    closer = CloseRawLayer(context)
    replace_layer(context, current, closer)
    nextlayer.layer = closer


def apply_http_policy(flow: object, raw_url: str) -> None:
    if http is None:
        raise RuntimeError("mitmproxy is required to run the Eval egress filter")
    try:
        matched = contamination_rule(raw_url)
        if not matched:
            return
        rule_id, host, normalized_path = matched
        append_audit(rule_id, host, normalized_path)
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
            append_audit("policy_error", "", type(error).__name__)
        except Exception:
            pass


def connect_target_url(flow: object) -> str:
    request = flow.request
    host = (getattr(request, "pretty_host", None) or getattr(request, "host", "") or "").strip()
    if not host:
        raise ValueError("empty CONNECT host")
    if ":" in host and not host.startswith("["):
        host = f"[{host}]"
    port = getattr(request, "port", None)
    if port in (None, 443):
        return f"https://{host}/"
    if port == 80:
        return f"http://{host}/"
    return f"https://{host}:{port}/"


def looks_like_raw_tcp(nextlayer: object) -> bool:
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


def tcp_peer(flow: object) -> tuple[str, str]:
    server = getattr(flow, "server_conn", None) or getattr(flow, "server", None)
    address = getattr(server, "address", None) if server is not None else None
    if isinstance(address, (tuple, list)) and address:
        host = str(address[0])[:255]
        port = address[1] if len(address) > 1 else ""
        return host, f":{port}" if port != "" else ""
    return "", ""


def record_raw_tunnel(flow: object) -> None:
    host, path = tcp_peer(flow)
    try:
        append_audit("raw_tunnel", host, path)
    except Exception:
        pass


def kill_flow(flow: object) -> None:
    kill = getattr(flow, "kill", None)
    if callable(kill) and getattr(flow, "killable", True):
        try:
            kill()
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


class CloseRawLayer(Layer):
    def __init__(self, context: object) -> None:
        if Layer is object:
            self.context = context
            return
        if getattr(context, "layers", None) is None:
            context.layers = []
        if getattr(context, "options", None) is None:
            context.options = type("Options", (), {"proxy_debug": False})()
        super().__init__(context)

    def handle_event(self, event: object):
        if proxy_commands is None:
            return
            yield
        for name in ("client", "server"):
            connection = getattr(self.context, name, None)
            if connection is not None:
                yield proxy_commands.CloseConnection(connection)


def blocked_response(rule_id: str):
    return http.Response.make(
        451,
        b"Benchmark source or public solution access is blocked during evaluation.\n",
        {
            "Content-Type": "text/plain; charset=utf-8",
            "X-Maka-Eval-Egress-Rule": rule_id,
        },
    )


def append_audit(rule_id: str, host: str, normalized_path: str) -> None:
    AUDIT_PATH.parent.mkdir(parents=True, exist_ok=True)
    if AUDIT_PATH.exists() and AUDIT_PATH.stat().st_size >= MAX_AUDIT_BYTES:
        write_truncation_marker()
        return
    record = {
        "ts": int(time.time() * 1000),
        "ruleId": rule_id,
        "host": host[:255],
        "normalizedPath": normalized_path[:4096],
    }
    with AUDIT_PATH.open("a", encoding="utf-8") as stream:
        stream.write(json.dumps(record, ensure_ascii=True, separators=(",", ":")) + "\n")


def write_truncation_marker() -> None:
    if audit_already_truncated():
        return
    record = {
        "ts": int(time.time() * 1000),
        "ruleId": "audit_truncated",
        "host": "",
        "normalizedPath": "",
    }
    prefix = ""
    if AUDIT_PATH.exists() and AUDIT_PATH.stat().st_size > 0:
        with AUDIT_PATH.open("rb") as stream:
            stream.seek(-1, os.SEEK_END)
            if stream.read(1) != b"\n":
                prefix = "\n"
    with AUDIT_PATH.open("a", encoding="utf-8") as stream:
        stream.write(prefix + json.dumps(record, ensure_ascii=True, separators=(",", ":")) + "\n")


def audit_already_truncated() -> bool:
    if not AUDIT_PATH.exists():
        return False
    with AUDIT_PATH.open("rb") as stream:
        stream.seek(0, os.SEEK_END)
        size = stream.tell()
        stream.seek(max(0, size - 4096))
        tail = stream.read().decode("utf-8", errors="ignore")
    lines = [line for line in tail.splitlines() if line.strip()]
    if not lines:
        return False
    try:
        parsed = json.loads(lines[-1])
    except json.JSONDecodeError:
        return False
    return isinstance(parsed, dict) and parsed.get("ruleId") == "audit_truncated"
