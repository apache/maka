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
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("could not load trial runner")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def task_with_agent(**values):
    return SimpleNamespace(config=SimpleNamespace(agent=SimpleNamespace(**values)))


class RunTrialPolicyContract(unittest.TestCase):
    def test_required_egress_overrides_subject_network_configuration(self) -> None:
        for network_mode, allowed_hosts in ((None, None), ("none", []), ("host", ["x.ai"])):
            task = task_with_agent(network_mode=network_mode, allowed_hosts=allowed_hosts)
            with patch.dict(
                os.environ,
                {
                    "MAKA_EVAL_EGRESS_REQUIRED": "1",
                    "MAKA_EVAL_EGRESS_ALLOWED_HOST": "maka-eval-mitmproxy",
                },
                clear=True,
            ):
                MODULE.apply_subject_egress_policy(task)
            self.assertEqual(task.config.agent.network_mode, "allowlist")
            self.assertEqual(task.config.agent.allowed_hosts, ["maka-eval-mitmproxy"])

    def test_required_egress_fails_closed_without_a_nonempty_proxy_host(self) -> None:
        for host in (None, ""):
            environment = {"MAKA_EVAL_EGRESS_REQUIRED": "1"}
            if host is not None:
                environment["MAKA_EVAL_EGRESS_ALLOWED_HOST"] = host
            with self.subTest(host=host), patch.dict(os.environ, environment, clear=True):
                with self.assertRaisesRegex(RuntimeError, "proxy host is unavailable"):
                    MODULE.apply_subject_egress_policy(task_with_agent())

    def test_framework_validation_precedes_dynamic_import(self) -> None:
        with patch.object(MODULE.importlib, "import_module") as imported:
            with self.assertRaisesRegex(RuntimeError, "harbor or pier"):
                asyncio.run(MODULE.run_trial("other", "1.0.0", Path("missing.json")))
        imported.assert_not_called()

    def test_framework_is_installed_before_version_or_module_validation(self) -> None:
        import eval_framework

        for framework in ("harbor", "pier"):
            with self.subTest(framework=framework):
                with patch.object(MODULE.importlib.metadata, "version", return_value="different"):
                    with self.assertRaises(MODULE.FrameworkVersionMismatch):
                        asyncio.run(MODULE.run_trial(framework, "1.0.0", Path("missing.json")))
                self.assertEqual(eval_framework.current_framework(), framework)

    def test_main_forwards_the_cli_tuple_without_reinterpreting_it(self) -> None:
        observed = []

        async def fake_trial(framework, expected_version, config_file):
            observed.append((framework, expected_version, config_file))

        argv = ["run_trial.py", "pier", "1.2.3", "config.json"]
        with patch.object(sys, "argv", argv), patch.object(MODULE, "run_trial", fake_trial):
            asyncio.run(MODULE.main())
        self.assertEqual(observed, [("pier", "1.2.3", Path("config.json"))])


if __name__ == "__main__":
    unittest.main()
