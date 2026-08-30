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
    def test_resolves_each_framework_cleanup_budget_independently(self) -> None:
        config = SimpleNamespace(
            timeout_multiplier=2,
            agent_timeout_multiplier=None,
            agent=SimpleNamespace(
                override_timeout_sec=None,
                max_timeout_sec=4,
                kwargs={"relay_token": "token"},
            ),
        )
        self.assertEqual(MODULE.resolved_framework_timeout_ms(config, 3), 6000)
        self.assertEqual(MODULE.resolved_framework_timeout_ms(config, 1.5), 3000)
        self.assertEqual(config.agent.kwargs["relay_token"], "token")

    def test_harbor_multi_step_binds_the_current_step_timeout(self) -> None:
        budgets: list[int | None] = []
        calls: list[float | None] = []
        agent = SimpleNamespace(set_framework_timeout_ms=budgets.append)

        async def run_phase(*_args, **kwargs):
            calls.append(kwargs["timeout_sec"])

        trial = SimpleNamespace(agent=agent, _run_agent_phase=run_phase)
        MODULE.bind_framework_timeout_budget("harbor", trial)

        asyncio.run(trial._run_agent_phase(timeout_sec=1.0))
        asyncio.run(trial._run_agent_phase(timeout_sec=60.0))

        self.assertEqual(budgets, [1000, 60000])
        self.assertEqual(calls, [1.0, 60.0])

    def test_pier_single_and_multi_step_bind_the_effective_timeout(self) -> None:
        budgets: list[int | None] = []
        calls: list[str] = []
        agent = SimpleNamespace(set_framework_timeout_ms=budgets.append)
        config = SimpleNamespace(
            timeout_multiplier=1,
            agent_timeout_multiplier=None,
            agent=SimpleNamespace(override_timeout_sec=None, max_timeout_sec=None),
        )

        async def execute_agent():
            calls.append("single")

        async def execute_step_agent(step, _result):
            calls.append(step.name)

        def resolve_step_timeout(*, override, default, max_val, specific_multiplier):
            del override, max_val, specific_multiplier
            return default

        trial = SimpleNamespace(
            _agent=agent,
            _execution=SimpleNamespace(agent_timeout_sec=7.0),
            _execute_agent=execute_agent,
            _execute_step_agent=execute_step_agent,
            _resolve_step_timeout=resolve_step_timeout,
            _task=SimpleNamespace(config=SimpleNamespace(agent=SimpleNamespace(timeout_sec=30.0))),
            config=config,
        )
        MODULE.bind_framework_timeout_budget("pier", trial)

        asyncio.run(trial._execute_agent())
        asyncio.run(
            trial._execute_step_agent(
                SimpleNamespace(name="step-a", agent=SimpleNamespace(timeout_sec=2.5)),
                SimpleNamespace(),
            )
        )

        self.assertEqual(budgets, [7000, 2500])
        self.assertEqual(calls, ["single", "step-a"])

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

    def test_invalid_framework_fails_before_framework_import(self) -> None:
        with patch.object(MODULE.importlib, "import_module") as imported:
            with self.assertRaisesRegex(RuntimeError, "harbor or pier"):
                asyncio.run(MODULE.run_trial("other", "1.0.0", Path("missing.json")))
        imported.assert_not_called()

    def test_main_installs_the_argv_framework_before_the_trial(self) -> None:
        import eval_framework

        installed: list[str] = []

        async def fake_trial(framework: str, expected_version: str, config_file: Path) -> None:
            installed.append(eval_framework.selected())
            self.assertEqual(framework, "pier")
            self.assertEqual(expected_version, "1.2.3")

        with patch.object(sys, "argv", ["run_trial.py", "pier", "1.2.3", "config.json"]):
            with patch.object(MODULE, "run_trial", fake_trial):
                asyncio.run(MODULE.main())
        self.assertEqual(installed, ["pier"])


if __name__ == "__main__":
    unittest.main()
