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

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

MODULE_PATH = Path(__file__).with_name("egress_filter.py")
SPEC = importlib.util.spec_from_file_location("maka_eval_egress_filter", MODULE_PATH)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class EgressFilterTest(unittest.TestCase):
    def test_blocks_contamination_surfaces_and_recursive_jina_urls(self) -> None:
        blocked = {
            "https://github.com/harbor-framework/terminal-bench-2-1": "benchmark_repository",
            "https://api.github.com/repos/terminal-benchmarks/terminal-bench/issues": "benchmark_repository",
            "https://raw.githubusercontent.com/tbench-ai/terminal-bench/main/tests/x": "benchmark_repository",
            "https://huggingface.co/datasets/acme/terminal-bench-traces": "terminal_bench_url",
            "https://github.com/hqeric/maka-eval-trajectories": "public_trajectory",
            "https://spylab.ai/reference/terminalbench-solution": "terminal_bench_url",
            "https://example.test/patches-terminalbench-task-1.diff": "known_patch_artifact",
            f"https://example.test/archive?revision={MODULE.PINNED_REVISION}": "pinned_revision",
            "https://tbench.ai/tasks": "tbench_domain",
            "https://hub.harborframework.com/tasks/terminal-bench/foo": "harbor_task_registry",
            "https://r.jina.ai/https://github.com/harbor-framework/terminal-bench-2-1": "jina_recursive:benchmark_repository",
            "https://r.jina.ai/https%253A%252F%252Fspylab.ai%252Fterminal-bench": "jina_recursive:terminal_bench_url",
            "https://example.test/search?q=TeRmInAlBeNcH": "terminal_bench_url",
            "https://google.com/search?q=terminal+bench": "terminal_bench_url",
            "https://github.com/harbor-framework/terminal%252Dbench-2-1.git": "benchmark_repository",
            "https://terminal-bench.io/tasks/answers": "terminal_bench_url",
            "https://sub.tbench.ai/x": "tbench_domain",
            # A DNS label is as good a place to name a contamination surface as
            # a path, so every rule searches both fields.
            f"https://{MODULE.PINNED_REVISION}.example.test/archive": "pinned_revision",
            "https://patches-terminalbench-task-1.example.test/x": "known_patch_artifact",
        }
        for url, rule_id in blocked.items():
            matched = MODULE.contamination_rule(url)
            self.assertIsNotNone(matched, url)
            self.assertEqual(matched[0], rule_id, url)

    def test_preserves_unrelated_network_and_rejects_malformed_urls(self) -> None:
        allowed = [
            "https://github.com/harbor-framework/harbor",
            "https://github.com/microsoft/terminal",
            "https://huggingface.co/datasets/mteb/leaderboard",
            "https://pypi.org/simple/requests/",
            "https://deb.debian.org/debian/",
            "https://my-terminal/bench",
        ]
        for url in allowed:
            self.assertIsNone(MODULE.contamination_rule(url), url)
        for url in ["", "file:///tmp/terminal-bench.log", "https://example.test/%ZZ"]:
            with self.assertRaises(ValueError, msg=url):
                MODULE.contamination_rule(url)

    def _install_response_stub(self) -> None:
        class Response:
            @staticmethod
            def make(status, body, headers):
                return {"status": status, "body": body, "headers": headers}

        MODULE.http = SimpleNamespace(Response=Response)

    def test_request_blocks_a_contamination_url_and_appends_one_audit_record(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            self._install_response_stub()
            MODULE.AUDIT_PATH = Path(directory) / "hits.jsonl"
            flow = type(
                "Flow",
                (),
                {"request": type("Request", (), {"pretty_url": "https://tbench.ai/tasks"})()},
            )()
            MODULE.request(flow)
            self.assertEqual(flow.response["status"], 451)
            self.assertEqual(
                flow.response["headers"]["X-Maka-Eval-Egress-Rule"], "tbench_domain"
            )
            lines = MODULE.AUDIT_PATH.read_text().splitlines()
            self.assertEqual(len(lines), 1)
            record = json.loads(lines[0])
            self.assertEqual(record["ruleId"], "tbench_domain")
            self.assertEqual(record["host"], "tbench.ai")
            self.assertEqual(record["normalizedPath"], "/tasks")

    def test_request_leaves_an_unrelated_url_unanswered(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            self._install_response_stub()
            MODULE.AUDIT_PATH = Path(directory) / "hits.jsonl"
            flow = type(
                "Flow",
                (),
                {"request": type("Request", (), {"pretty_url": "https://example.com/"})()},
            )()
            MODULE.request(flow)
            self.assertFalse(hasattr(flow, "response"))
            self.assertFalse(MODULE.AUDIT_PATH.exists())

    def test_audit_is_bounded_and_policy_errors_fail_closed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            self._install_response_stub()
            MODULE.AUDIT_PATH = Path(directory) / "hits.jsonl"
            flow = type(
                "Flow",
                (),
                {"request": type("Request", (), {"pretty_url": "https://example.test/%ZZ"})()},
            )()
            MODULE.request(flow)
            self.assertEqual(flow.response["status"], 503)
            record = json.loads(MODULE.AUDIT_PATH.read_text().splitlines()[0])
            self.assertEqual(record["ruleId"], "policy_error")
            self.assertIn("host", record)
            self.assertIn("normalizedPath", record)

    def test_http_connect_refuses_blocklisted_hosts_before_the_tunnel_opens(self) -> None:
        class Response:
            @staticmethod
            def make(status, body, headers):
                return {"status": status, "body": body, "headers": headers}

        with tempfile.TemporaryDirectory() as directory:
            MODULE.http = SimpleNamespace(Response=Response)
            MODULE.AUDIT_PATH = Path(directory) / "hits.jsonl"
            blocked = type(
                "Flow",
                (),
                {
                    "request": type(
                        "Request",
                        (),
                        {"pretty_host": "tbench.ai", "host": "tbench.ai", "port": 443},
                    )()
                },
            )()
            MODULE.http_connect(blocked)
            self.assertEqual(blocked.response["status"], 451)
            self.assertEqual(blocked.response["headers"]["X-Maka-Eval-Egress-Rule"], "tbench_domain")
            record = json.loads(MODULE.AUDIT_PATH.read_text().splitlines()[0])
            self.assertEqual(record["ruleId"], "tbench_domain")
            self.assertEqual(record["host"], "tbench.ai")

            for host in ("example.com", "github.com", "ssh.github.com"):
                allowed = type(
                    "Flow",
                    (),
                    {
                        "request": type(
                            "Request",
                            (),
                            {"pretty_host": host, "host": host, "port": 443},
                        )(),
                        "response": None,
                    },
                )()
                MODULE.http_connect(allowed)
                self.assertIsNone(allowed.response, host)

    def test_tcp_start_kills_raw_tunnels_and_records_them(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            MODULE.AUDIT_PATH = Path(directory) / "hits.jsonl"
            killed: list[str] = []
            flow = type(
                "Flow",
                (),
                {"server_conn": SimpleNamespace(address=("ssh.github.com", 443))},
            )()
            flow.kill = lambda: killed.append("killed")
            MODULE.tcp_start(flow)
            self.assertEqual(killed, ["killed"])
            record = json.loads(MODULE.AUDIT_PATH.read_text().splitlines()[0])
            self.assertEqual(record["ruleId"], "raw_tunnel")
            self.assertEqual(record["host"], "ssh.github.com")
            self.assertEqual(record["normalizedPath"], ":443")

    def test_tcp_message_drops_raw_payloads(self) -> None:
        message = SimpleNamespace(content=b"SSH-2.0-test\r\n")
        killed: list[str] = []
        flow = SimpleNamespace(messages=[message], killable=True)
        flow.kill = lambda: killed.append("killed")
        MODULE.tcp_message(flow)
        self.assertEqual(message.content, b"")
        self.assertEqual(killed, ["killed"])

    def test_next_layer_closes_raw_tcp_before_the_builtin_classifier(self) -> None:
        class CloseConnection:
            def __init__(self, connection: object) -> None:
                self.connection = connection

        with tempfile.TemporaryDirectory() as directory:
            MODULE.AUDIT_PATH = Path(directory) / "hits.jsonl"
            previous_commands = MODULE.proxy_commands
            self.addCleanup(setattr, MODULE, "proxy_commands", previous_commands)
            MODULE.proxy_commands = SimpleNamespace(CloseConnection=CloseConnection)
            client = object()
            server = SimpleNamespace(address=("ssh.github.com", 443))
            context = SimpleNamespace(client=client, server=server, layers=[], options=None)

            def data_client() -> bytes:
                return b"SSH-2.0-OpenSSH_9.0"

            nextlayer = SimpleNamespace(
                layer=None, context=context, data_client=data_client, data_server=lambda: b""
            )
            MODULE.next_layer(nextlayer)
            self.assertIsInstance(nextlayer.layer, MODULE.CloseRawLayer)
            commands = list(nextlayer.layer.handle_event(object()))
            self.assertEqual([command.connection for command in commands], [client, server])
            record = json.loads(MODULE.AUDIT_PATH.read_text().splitlines()[0])
            self.assertEqual(record["ruleId"], "raw_tunnel")
            self.assertEqual(record["host"], "ssh.github.com")

    def test_next_layer_routes_tls_and_http_without_raw_fallback(self) -> None:
        class FakeServerTLSLayer:
            child_layer: object | None = None

            def __init__(self, context: object) -> None:
                self.context = context
                context.layers.append(self)

        class FakeClientTLSLayer:
            def __init__(self, context: object) -> None:
                self.context = context
                context.layers.append(self)

        previous_server_tls = MODULE.ServerTLSLayer
        previous_client_tls = MODULE.ClientTLSLayer
        self.addCleanup(setattr, MODULE, "ServerTLSLayer", previous_server_tls)
        self.addCleanup(setattr, MODULE, "ClientTLSLayer", previous_client_tls)
        MODULE.ServerTLSLayer = FakeServerTLSLayer
        MODULE.ClientTLSLayer = FakeClientTLSLayer

        context = SimpleNamespace(layers=[])
        tls = SimpleNamespace(
            layer=None,
            context=context,
            data_client=lambda: b"\x16\x03\x01\x00\x00",
            data_server=lambda: b"",
        )
        MODULE.next_layer(tls)
        self.assertIsNone(tls.layer)

        for first, remainder in (
            (b"\x16", b"\x03\x01\x00\x00"),
            (b"\x16\x03", b"\x01\x00\x00"),
        ):
            with self.subTest(tls_prefix=first):
                fragmented_context = SimpleNamespace(layers=[])
                fragmented = SimpleNamespace(
                    layer=None,
                    context=fragmented_context,
                    data_client=lambda first=first: first,
                    data_server=lambda: b"",
                )
                MODULE.next_layer(fragmented)
                self.assertIsInstance(fragmented.layer, FakeServerTLSLayer)
                self.assertIsInstance(fragmented.layer.child_layer, FakeClientTLSLayer)
                self.assertEqual(
                    fragmented_context.layers,
                    [fragmented.layer, fragmented.layer.child_layer],
                )
                self.assertTrue((first + remainder).startswith(b"\x16\x03"))

        http = SimpleNamespace(
            layer=None,
            context=context,
            data_client=lambda: b"GET / HTTP/1.1\r\n",
            data_server=lambda: b"",
        )
        MODULE.next_layer(http)
        self.assertIsNone(http.layer)

        empty = SimpleNamespace(
            layer=None,
            context=context,
            data_client=lambda: b"",
            data_server=lambda: b"",
        )
        MODULE.next_layer(empty)
        self.assertIsNone(empty.layer)

        for prefix in (b"G", b"GE", b"GET", b"GET ", b"GET / HTTP/1.1"):
            with self.subTest(prefix=prefix):
                incomplete = SimpleNamespace(
                    layer=None,
                    context=context,
                    data_client=lambda prefix=prefix: prefix,
                    data_server=lambda: b"",
                )
                MODULE.next_layer(incomplete)
                self.assertIsNone(incomplete.layer)

    def test_next_layer_closes_bytes_that_cannot_become_http(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            MODULE.AUDIT_PATH = Path(directory) / "hits.jsonl"
            context = SimpleNamespace(
                layers=[], options=None, client=object(), server=None
            )
            binary = SimpleNamespace(
                layer=None,
                context=context,
                data_client=lambda: b"\x00\x01\x02\x03",
                data_server=lambda: b"",
            )
            MODULE.next_layer(binary)
            self.assertIsInstance(binary.layer, MODULE.CloseRawLayer)

    def test_response_audits_a_non_websocket_101_upgrade(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            MODULE.AUDIT_PATH = Path(directory) / "hits.jsonl"
            raw = type(
                "Flow",
                (),
                {
                    "response": SimpleNamespace(
                        status_code=101, headers={"upgrade": "raw"}
                    ),
                    "server_conn": SimpleNamespace(address=("origin", 19083)),
                },
            )()
            MODULE.response(raw)
            record = json.loads(MODULE.AUDIT_PATH.read_text().splitlines()[0])
            self.assertEqual(record["ruleId"], "raw_tunnel")

            websocket = type(
                "Flow",
                (),
                {
                    "response": SimpleNamespace(
                        status_code=101, headers={"upgrade": "websocket"}
                    ),
                    "websocket": object(),
                    "server_conn": SimpleNamespace(address=("origin", 19082)),
                },
            )()
            MODULE.response(websocket)
            self.assertEqual(len(MODULE.AUDIT_PATH.read_text().splitlines()), 1)

            invalid = type(
                "Flow",
                (),
                {
                    "response": SimpleNamespace(
                        status_code=101, headers={"upgrade": "websocket"}
                    ),
                    "server_conn": SimpleNamespace(address=("origin", 19082)),
                },
            )()
            MODULE.response(invalid)
            self.assertEqual(len(MODULE.AUDIT_PATH.read_text().splitlines()), 2)
            self.assertEqual(
                json.loads(MODULE.AUDIT_PATH.read_text().splitlines()[1])["ruleId"],
                "raw_tunnel",
            )

    def test_next_layer_replaces_raw_tcp_with_a_closer(self) -> None:
        class FakeTCPLayer:
            def __init__(self, context: object) -> None:
                self.context = context
                context.layers.append(self)

        class CloseConnection:
            def __init__(self, connection: object) -> None:
                self.connection = connection

        with tempfile.TemporaryDirectory() as directory:
            MODULE.AUDIT_PATH = Path(directory) / "hits.jsonl"
            previous_tcp = MODULE.TCPLayer
            previous_commands = MODULE.proxy_commands
            self.addCleanup(setattr, MODULE, "TCPLayer", previous_tcp)
            self.addCleanup(setattr, MODULE, "proxy_commands", previous_commands)
            MODULE.TCPLayer = FakeTCPLayer
            MODULE.proxy_commands = SimpleNamespace(CloseConnection=CloseConnection)
            client = object()
            server = SimpleNamespace(address=("ssh.github.com", 443))
            sibling = object()
            context = SimpleNamespace(
                client=client, server=server, layers=[sibling], options=None
            )
            current = FakeTCPLayer(context)
            nextlayer = SimpleNamespace(layer=current, context=context)
            MODULE.next_layer(nextlayer)
            self.assertIsInstance(nextlayer.layer, MODULE.CloseRawLayer)
            self.assertIsInstance(nextlayer.layer, MODULE.Layer)
            self.assertEqual(context.layers, [sibling, nextlayer.layer])
            self.assertNotIn(current, context.layers)
            commands = list(nextlayer.layer.handle_event(object()))
            self.assertEqual([command.connection for command in commands], [client, server])
            self.assertTrue(all(isinstance(command, CloseConnection) for command in commands))
            record = json.loads(MODULE.AUDIT_PATH.read_text().splitlines()[0])
            self.assertEqual(record["ruleId"], "raw_tunnel")
            self.assertEqual(record["host"], "ssh.github.com")

    def test_next_layer_leaves_an_unclassified_layer_alone(self) -> None:
        context = SimpleNamespace(layers=[])
        nextlayer = SimpleNamespace(layer=None, context=context)
        MODULE.next_layer(nextlayer)
        self.assertIsNone(nextlayer.layer)
        self.assertEqual(context.layers, [])

    def test_next_layer_leaves_non_tcp_layers_alone(self) -> None:
        class HTTPLayer:
            pass

        original = HTTPLayer()
        nextlayer = SimpleNamespace(layer=original, context=SimpleNamespace())
        MODULE.next_layer(nextlayer)
        self.assertIs(nextlayer.layer, original)

    def test_audit_escapes_line_separators_so_python_and_typescript_agree(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            MODULE.AUDIT_PATH = Path(directory) / "hits.jsonl"
            path = "/tasks/\u2028hidden"
            MODULE.append_audit("tbench_domain", "tbench.ai", path)
            raw = MODULE.AUDIT_PATH.read_text(encoding="utf-8")
            self.assertNotIn("\u2028", raw)
            self.assertIn("\\u2028", raw)
            self.assertEqual(raw.count("\n"), 1)
            self.assertEqual(len(raw.splitlines()), 1)
            record = json.loads(raw)
            self.assertEqual(record["normalizedPath"], path)
            self.assertFalse(MODULE.audit_already_truncated())

    def test_audit_writes_one_truncation_marker_when_the_byte_limit_is_reached(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            MODULE.AUDIT_PATH = Path(directory) / "hits.jsonl"
            MODULE.AUDIT_PATH.write_bytes(b"x" * MODULE.MAX_AUDIT_BYTES)
            MODULE.append_audit("tbench_domain", "tbench.ai", "/tasks")
            records = [
                json.loads(line)
                for line in MODULE.AUDIT_PATH.read_text().splitlines()
                if line.startswith("{")
            ]
            self.assertEqual(records[-1]["ruleId"], "audit_truncated")
            size_after_marker = MODULE.AUDIT_PATH.stat().st_size
            MODULE.append_audit("tbench_domain", "tbench.ai", "/other")
            self.assertEqual(MODULE.AUDIT_PATH.stat().st_size, size_after_marker)
            records_after = [
                json.loads(line)
                for line in MODULE.AUDIT_PATH.read_text().splitlines()
                if line.startswith("{")
            ]
            self.assertEqual(
                [record["ruleId"] for record in records_after if record["ruleId"] == "audit_truncated"],
                ["audit_truncated"],
            )

    def test_truncation_probe_ignores_non_object_json_tails(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            MODULE.AUDIT_PATH = Path(directory) / "hits.jsonl"
            MODULE.AUDIT_PATH.write_text('123\n"x"\n')
            self.assertFalse(MODULE.audit_already_truncated())
            MODULE.write_truncation_marker()
            self.assertTrue(MODULE.audit_already_truncated())


if __name__ == "__main__":
    unittest.main()
