import importlib.util
import os
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

MODULE_PATH = Path(__file__).with_name("run_trial.py")
SPEC = importlib.util.spec_from_file_location("maka_eval_run_trial", MODULE_PATH)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class RunTrialPolicyTest(unittest.TestCase):
    def test_forces_only_the_subject_phase_through_the_cell_proxy(self) -> None:
        agent = SimpleNamespace(network_mode=None, allowed_hosts=None)
        task = SimpleNamespace(config=SimpleNamespace(agent=agent))
        with patch.dict(
            os.environ,
            {
                "MAKA_EVAL_EGRESS_REQUIRED": "1",
                "MAKA_EVAL_EGRESS_ALLOWED_HOST": "maka-eval-mitmproxy",
            },
            clear=False,
        ):
            MODULE.apply_subject_egress_policy(task)
        self.assertEqual(agent.network_mode, "allowlist")
        self.assertEqual(agent.allowed_hosts, ["maka-eval-mitmproxy"])

    def test_required_egress_fails_closed_without_the_proxy_host(self) -> None:
        task = SimpleNamespace(config=SimpleNamespace(agent=SimpleNamespace()))
        with patch.dict(os.environ, {"MAKA_EVAL_EGRESS_REQUIRED": "1"}, clear=True):
            with self.assertRaisesRegex(RuntimeError, "proxy host is unavailable"):
                MODULE.apply_subject_egress_policy(task)


if __name__ == "__main__":
    unittest.main()
