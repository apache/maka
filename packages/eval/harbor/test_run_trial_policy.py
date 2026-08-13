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
        trial = SimpleNamespace(task=SimpleNamespace(config=SimpleNamespace(agent=agent)))
        with patch.dict(
            os.environ,
            {"MAKA_EVAL_EGRESS_ALLOWED_HOST": "maka-eval-mitmproxy"},
            clear=False,
        ):
            MODULE.apply_subject_egress_policy(trial)
        self.assertEqual(agent.network_mode, "allowlist")
        self.assertEqual(agent.allowed_hosts, ["maka-eval-mitmproxy"])


if __name__ == "__main__":
    unittest.main()
