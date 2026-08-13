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
        ]
        for url in allowed:
            self.assertIsNone(MODULE.contamination_rule(url), url)
        for url in ["", "file:///tmp/terminal-bench.log", "https://example.test/%ZZ"]:
            with self.assertRaises(ValueError, msg=url):
                MODULE.contamination_rule(url)

    def test_audit_is_bounded_and_policy_errors_fail_closed(self) -> None:
        class Response:
            @staticmethod
            def make(status, body, headers):
                return {"status": status, "body": body, "headers": headers}

        with tempfile.TemporaryDirectory() as directory:
            MODULE.http = SimpleNamespace(Response=Response)
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


if __name__ == "__main__":
    unittest.main()
