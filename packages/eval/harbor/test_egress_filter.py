import importlib.util
import unittest
from pathlib import Path

MODULE_PATH = Path(__file__).with_name("egress_filter.py")
SPEC = importlib.util.spec_from_file_location("maka_eval_egress_filter", MODULE_PATH)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class EgressFilterTest(unittest.TestCase):
    def test_blocks_only_terminal_bench_repository_paths(self) -> None:
        blocked = [
            "https://github.com/harbor-framework/terminal-bench-2",
            "https://github.com/NousResearch/terminal-bench/tree/main",
            "https://api.github.com/repos/harbor-framework/terminal-bench-2-1/contents/tasks",
            "https://raw.githubusercontent.com/NousResearch/terminal-bench/main/README.md",
            "https://codeload.github.com/harbor-framework/terminal-bench-2.1/tar.gz/main",
        ]
        allowed = [
            "https://github.com/harbor-framework/harbor",
            "https://api.github.com/repos/other/terminal-bench",
            "https://raw.githubusercontent.com/other/project/main/data.txt",
            "https://pypi.org/simple/requests/",
            "https://huggingface.co/datasets/example/data",
        ]
        for url in blocked:
            self.assertTrue(MODULE.blocked_terminal_bench_url(url), url)
        for url in allowed:
            self.assertFalse(MODULE.blocked_terminal_bench_url(url), url)


if __name__ == "__main__":
    unittest.main()
