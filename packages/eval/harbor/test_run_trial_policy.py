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

import asyncio
import importlib.util
import os
import sys
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

    def test_rejects_unknown_framework_without_loading_its_modules(self) -> None:
        with patch.object(MODULE.importlib, "import_module") as imported:
            with self.assertRaisesRegex(RuntimeError, "harbor or pier"):
                asyncio.run(MODULE.run_trial("other", "1.0.0", Path("missing.json")))
        imported.assert_not_called()

    def test_trial_installs_its_framework_before_loading_modules(self) -> None:
        import eval_framework

        with patch.object(MODULE.importlib.metadata, "version", return_value="different"):
            with self.assertRaises(MODULE.FrameworkVersionMismatch):
                asyncio.run(MODULE.run_trial("harbor", "1.0.0", Path("missing.json")))
        self.assertEqual(eval_framework.current_framework(), "harbor")

    def test_main_binds_the_argv_framework_during_the_trial(self) -> None:
        import eval_framework

        observed: list[tuple[str, str, Path]] = []

        async def fake_trial(framework: str, expected_version: str, config_file: Path) -> None:
            observed.append((framework, expected_version, config_file))

        with patch.object(sys, "argv", ["run_trial.py", "pier", "1.2.3", "config.json"]):
            with patch.object(MODULE, "run_trial", fake_trial):
                asyncio.run(MODULE.main())
        self.assertEqual(observed, [("pier", "1.2.3", Path("config.json"))])


if __name__ == "__main__":
    unittest.main()
