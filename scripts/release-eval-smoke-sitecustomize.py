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

"""Minimal offline Harbor API used by the extracted CLI release smoke."""

import asyncio
import importlib.metadata
import json
import os
import sys
import tempfile
import types
from pathlib import Path
from types import SimpleNamespace


def register(name: str, package: bool = False) -> types.ModuleType:
    module = types.ModuleType(name)
    if package:
        module.__path__ = []
    sys.modules[name] = module
    parent_name, _, child_name = name.rpartition(".")
    if parent_name:
        setattr(sys.modules[parent_name], child_name, module)
    return module


harbor = register("harbor", package=True)
agents = register("harbor.agents", package=True)
base = register("harbor.agents.base")
models = register("harbor.models", package=True)
trial_models = register("harbor.models.trial", package=True)
trial_config = register("harbor.models.trial.config")
trial_package = register("harbor.trial", package=True)
trial_module = register("harbor.trial.trial")
single_step = register("harbor.trial.single_step")
constants = register("harbor.constants")


class BaseAgent:
    def __init__(self, *args, **kwargs):
        pass


base.BaseAgent = BaseAgent
constants.TASK_CACHE_DIR = Path(os.environ["MAKA_CLI_EVAL_SMOKE_CACHE"])


class TaskIdentity:
    def __init__(self, value):
        self.value = value

    def model_dump_json(self):
        return json.dumps(self.value, sort_keys=True)


class TaskConfig(SimpleNamespace):
    def get_task_id(self):
        return TaskIdentity(self.__dict__)


def namespace(value, task=False):
    if isinstance(value, dict):
        values = {key: namespace(child) for key, child in value.items()}
        return TaskConfig(**values) if task else SimpleNamespace(**values)
    if isinstance(value, list):
        return [namespace(child) for child in value]
    return value


class TrialConfig:
    @classmethod
    def model_validate_json(cls, raw):
        value = json.loads(raw)
        config = namespace(value)
        config.task = namespace(value["task"], task=True)
        return config


trial_config.TrialConfig = TrialConfig


class Trial:
    @staticmethod
    def _resolve_agent_skills(config):
        return None

    @staticmethod
    async def _load_task(config):
        task_dir = Path(config.task.download_dir) / "release-smoke"
        task_dir.mkdir(parents=True, exist_ok=True)
        (task_dir / "task.txt").write_text("release smoke\n")
        task = SimpleNamespace(
            has_steps=False,
            config=SimpleNamespace(agent=config.agent),
            task_dir=str(task_dir),
        )
        return task, None


trial_module.Trial = Trial


class SingleStepTrial:
    def __init__(self, config, _task, _task_download_result):
        self.config = config
        self.task = _task

    async def run(self):
        from relay_agent import RelayAgent

        kwargs = self.config.agent.kwargs
        reader, writer = await asyncio.open_connection(
            kwargs.relay_host, kwargs.relay_port
        )

        def send(value):
            writer.write((json.dumps(value, separators=(",", ":")) + "\n").encode())

        send(
            {
                "token": kwargs.relay_token,
                "kind": "ready",
                "instruction": "release smoke",
                "cwd": tempfile.gettempdir(),
            }
        )
        await writer.drain()
        execute = json.loads(await reader.readline())
        if (
            execute.get("token") != kwargs.relay_token
            or execute.get("kind") != "execute"
        ):
            raise RuntimeError("invalid execute request")
        if execute.get("command") != "/usr/bin/true" or execute.get("args") != []:
            raise RuntimeError("unexpected release smoke command")
        send(
            {
                "token": kwargs.relay_token,
                "kind": "executed",
                "termination": "exited",
                "exitCode": 0,
                "stdout": "",
                "diagnostic": {"category": "none"},
            }
        )
        await writer.drain()
        decision = json.loads(await reader.readline())
        if (
            decision.get("token") != kwargs.relay_token
            or decision.get("kind") != "verify"
        ):
            raise RuntimeError("invalid verify decision")

        trial_dir = Path(self.config.trials_dir) / self.config.trial_name
        trial_dir.mkdir(parents=True, exist_ok=True)
        (trial_dir / "result.json").write_text(
            json.dumps(
                {
                    "exception_info": None,
                    "verifier_result": {"rewards": {"reward": 1}},
                }
            )
            + "\n"
        )
        Path(os.environ["MAKA_CLI_EVAL_SMOKE_MARKER"]).write_text(
            json.dumps(
                {
                    "runTrial": str(Path(sys.argv[0]).resolve()),
                    "relayAgent": str(
                        Path(sys.modules["relay_agent"].__file__).resolve()
                    ),
                    "relayName": RelayAgent.name(),
                }
            )
            + "\n"
        )
        writer.close()
        await writer.wait_closed()


single_step.SingleStepTrial = SingleStepTrial

metadata_version = importlib.metadata.version


def fixture_version(distribution_name):
    if distribution_name == "harbor":
        return "0.20.0"
    return metadata_version(distribution_name)


importlib.metadata.version = fixture_version
