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

    def _enable_http_responses(self) -> None:
        class FakeResponse:
            @staticmethod
            def make(status, body, headers):
                return {"status": status, "body": body, "headers": headers}

        MODULE.http = SimpleNamespace(Response=FakeResponse)

    @staticmethod
    def _request(url: str):
        flow = SimpleNamespace(request=SimpleNamespace(pretty_url=url))
        MODULE.request(flow)
        return flow

    def test_http_request_outcomes_are_auditable_and_fail_closed(self) -> None:
        expected = {
            "https://tbench.ai/tasks": (451, "tbench_domain"),
            "https://example.com/": (None, None),
            "https://example.test/%ZZ": (503, "policy_error"),
        }
        with tempfile.TemporaryDirectory() as directory:
            MODULE.AUDIT_PATH = Path(directory) / "hits.jsonl"
            self._enable_http_responses()
            for url, (status, rule_id) in expected.items():
                with self.subTest(url=url):
                    flow = self._request(url)
                    if status is None:
                        self.assertNotIn("response", vars(flow))
                        continue
                    self.assertEqual(flow.response["status"], status)
                    self.assertEqual(
                        flow.response["headers"]["X-Maka-Eval-Egress-Rule"], rule_id
                    )
            records = [json.loads(line) for line in MODULE.AUDIT_PATH.read_text().splitlines()]
            self.assertEqual(
                [record["ruleId"] for record in records],
                ["tbench_domain", "policy_error"],
            )
            self.assertEqual(
                (records[0]["host"], records[0]["normalizedPath"]),
                ("tbench.ai", "/tasks"),
            )

    def test_connect_classification_blocks_only_contamination_targets(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            self._enable_http_responses()
            MODULE.AUDIT_PATH = Path(directory) / "hits.jsonl"
            for host, expected_status in (
                ("tbench.ai", 451),
                ("example.com", None),
                ("github.com", None),
                ("ssh.github.com", None),
            ):
                with self.subTest(host=host):
                    flow = SimpleNamespace(
                        request=SimpleNamespace(host=host, port=443), response=None
                    )
                    MODULE.http_connect(flow)
                    actual = None if flow.response is None else flow.response["status"]
                    self.assertEqual(actual, expected_status)
            record = json.loads(MODULE.AUDIT_PATH.read_text().splitlines()[0])
            self.assertEqual(
                (record["ruleId"], record["host"]),
                ("tbench_domain", "tbench.ai"),
            )

    def test_connect_policy_uses_the_tunnel_target_not_a_spoofed_host_header(self) -> None:
        class Response:
            @staticmethod
            def make(status, body, headers):
                return {"status": status, "body": body, "headers": headers}

        with tempfile.TemporaryDirectory() as directory:
            MODULE.http = SimpleNamespace(Response=Response)
            MODULE.AUDIT_PATH = Path(directory) / "hits.jsonl"
            flow = SimpleNamespace(
                request=SimpleNamespace(
                    host="tbench.ai", pretty_host="example.com", port=443
                ),
                response=None,
            )

            MODULE.http_connect(flow)

            self.assertEqual(flow.response["status"], 451)
            self.assertEqual(
                json.loads(MODULE.AUDIT_PATH.read_text().splitlines()[0])["host"],
                "tbench.ai",
            )

            flow.request.host = ""
            flow.response = None
            MODULE.http_connect(flow)
            self.assertEqual(flow.response["status"], 503)

    def test_connect_rejects_malformed_authorities_and_ports(self) -> None:
        self._enable_http_responses()
        with tempfile.TemporaryDirectory() as directory:
            MODULE.AUDIT_PATH = Path(directory) / "hits.jsonl"
            for host, port in (
                ("tbench.ai@safe.example", 443),
                ("safe.example/path", 443),
                ("safe.example", 0),
                ("safe.example", 65536),
            ):
                with self.subTest(host=host, port=port):
                    flow = SimpleNamespace(
                        request=SimpleNamespace(host=host, port=port), response=None
                    )
                    MODULE.http_connect(flow)
                    self.assertEqual(flow.response["status"], 503)

            valid = SimpleNamespace(
                request=SimpleNamespace(host="2001:db8::1", port=8443), response=None
            )
            MODULE.http_connect(valid)
            self.assertIsNone(valid.response)

    def test_connect_target_normalization_is_pure_and_fail_closed(self) -> None:
        target = MODULE.parse_connect_target("example.com", 8443)
        self.assertEqual(
            (target.host, target.port, target.url),
            ("example.com", 8443, "https://example.com:8443/"),
        )
        self.assertEqual(MODULE.connect_url("example.com", None), "https://example.com/")
        self.assertEqual(MODULE.connect_url("example.com", 80), "http://example.com/")
        self.assertEqual(MODULE.connect_url("example.com", 8443), "https://example.com:8443/")
        self.assertEqual(MODULE.connect_url("2001:db8::1", 443), "https://[2001:db8::1]/")
        for host, port in (
            ("user@example.com", 443),
            ("example.com/path", 443),
            (" example.com", 443),
            ("example.com", True),
            ("example.com", 65536),
        ):
            with self.subTest(host=host, port=port):
                with self.assertRaises(ValueError):
                    MODULE.connect_url(host, port)

    def test_connect_adapter_does_not_accept_url_semantics_from_the_caller(self) -> None:
        for host in ("https://tbench.ai", "tbench.ai/path", "tbench.ai?query=1"):
            with self.subTest(host=host):
                with self.assertRaises(ValueError):
                    MODULE.parse_connect_target(host, 443)

    def test_raw_tcp_hooks_erase_payload_close_flow_and_record_peer(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            MODULE.AUDIT_PATH = Path(directory) / "hits.jsonl"
            closed: list[str] = []
            flow = SimpleNamespace(
                server_conn=SimpleNamespace(address=("ssh.github.com", 443)),
                messages=[SimpleNamespace(content=b"SSH-2.0-test\r\n")],
                killable=True,
            )
            flow.kill = lambda: closed.append("closed")
            MODULE.tcp_start(flow)
            MODULE.tcp_message(flow)
            self.assertEqual(closed, ["closed", "closed"])
            self.assertEqual(flow.messages[-1].content, b"")
            record = json.loads(MODULE.AUDIT_PATH.read_text().splitlines()[0])
            self.assertEqual(
                (record["ruleId"], record["host"], record["normalizedPath"]),
                ("raw_tunnel", "ssh.github.com", ":443"),
            )

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
            self.assertIsInstance(nextlayer.layer, MODULE.RejectRawTransport)
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
            self.assertIsInstance(binary.layer, MODULE.RejectRawTransport)

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
            self.assertIsInstance(nextlayer.layer, MODULE.RejectRawTransport)
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

if __name__ == "__main__":
    unittest.main()
