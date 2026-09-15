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
import importlib
import os
import shutil
import shlex
import subprocess
import sys
import tempfile
import types
import unittest
from pathlib import Path
from types import SimpleNamespace


class BaseAgent:
    def __init__(self, *args, **kwargs):
        pass


def load_relay():
    from eval_framework import install

    install("harbor")
    package = types.ModuleType("harbor")
    agents = types.ModuleType("harbor.agents")
    base = types.ModuleType("harbor.agents.base")
    base.BaseAgent = BaseAgent
    sys.modules["harbor"] = package
    sys.modules["harbor.agents"] = agents
    sys.modules["harbor.agents.base"] = base
    sys.modules.pop("relay_agent", None)
    return importlib.import_module("relay_agent")


class ArtifactEnvironment:
    def __init__(self, root: Path):
        self.root = root

    async def exec(self, command, cwd=None, timeout_sec=None):
        return SimpleNamespace(return_code=0, stdout="", stderr="")

    async def upload_file(self, source, target):
        destination = self.root / target.lstrip("/")
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, destination)


class RelayArtifactTest(unittest.IsolatedAsyncioTestCase):
    async def test_nonroot_setup_and_private_environment_keep_the_task_identity(self):
        relay = load_relay()

        class NonRootEnvironment(ArtifactEnvironment):
            async def exec(self, command, cwd=None, timeout_sec=None, user=None):
                if command.startswith('printf "%s:%s"'):
                    self.assert_default_user = user is None
                    return SimpleNamespace(return_code=0, stdout="10001:10001", stderr="")
                if user != "root":
                    return SimpleNamespace(return_code=1, stdout="", stderr="Permission denied")
                self.commands.append(command)
                return SimpleNamespace(return_code=0, stdout="", stderr="")

        with tempfile.TemporaryDirectory() as directory:
            environment = NonRootEnvironment(Path(directory))
            environment.commands = []
            agent = relay.RelayAgent(logs_dir=Path(directory), relay_host="127.0.0.1",
                                     relay_port=1, relay_token="test", teardown_timeout_ms=1000)
            await agent.setup(environment)
            command = await relay._prepare_command(environment, {
                "command": "/bin/true", "args": [], "credentials": {"API_KEY": "private"},
                "resultToken": "0" * 32,
            }, "test", "/logs/agent/test.pid", agent._subject_owner)
            self.assertTrue(environment.assert_default_user)
            self.assertIn("chown 10001:10001 /logs/agent /logs/artifacts", environment.commands[0])
            self.assertIn("chmod 600 /tmp/maka-eval-test.env", environment.commands[2])
            self.assertIn("chown 10001:10001", environment.commands[2])
            self.assertNotIn("private", command)

    async def test_setup_provisions_absent_system_home_without_rewriting_existing_home(self):
        relay = load_relay()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            home = root / "nonexistent"
            fake_bin = root / "bin"
            fake_bin.mkdir()
            getent = fake_bin / "getent"
            getent.write_text(
                "#!/bin/sh\nprintf '%s\\n' "
                + shlex.quote(f"task:x:{os.getuid()}:{os.getgid()}::{home}:/bin/sh")
                + "\n"
            )
            getent.chmod(0o755)

            class LocalSetupEnvironment:
                async def exec(self, command, user=None):
                    if command.startswith('printf "%s:%s"'):
                        return SimpleNamespace(return_code=0, stdout=f"{os.getuid()}:{os.getgid()}")
                    # Only the container API and its passwd database are doubles;
                    # execute the production home preparation against real files.
                    command = command.replace("/logs/", f"{root}/logs/")
                    result = subprocess.run(
                        ["sh", "-c", command], capture_output=True, text=True,
                        env={**os.environ, "PATH": f"{fake_bin}:{os.environ['PATH']}"},
                    )
                    return SimpleNamespace(return_code=result.returncode, stdout=result.stdout)

            agent = relay.RelayAgent(logs_dir=root, relay_host="127.0.0.1",
                                     relay_port=1, relay_token="test", teardown_timeout_ms=1000)
            await agent.setup(LocalSetupEnvironment())
            self.assertTrue(home.is_dir())
            self.assertEqual(home.stat().st_mode & 0o777, 0o700)
            self.assertEqual(home.stat().st_uid, os.getuid())
            (home / "retained").write_text("existing account data")
            home.chmod(0o755)
            await agent.setup(LocalSetupEnvironment())
            self.assertEqual(home.stat().st_mode & 0o777, 0o755)
            self.assertEqual((home / "retained").read_text(), "existing account data")

    async def test_framed_transport_outputs_are_persisted_without_changing_the_carrier(self):
        relay = load_relay()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            environment = ArtifactEnvironment(root)
            result = SimpleNamespace(stdout="framed-result\n", stderr="diagnostic\n")

            await relay._persist_subject_outputs(environment, result)

            self.assertEqual(
                (root / relay.SUBJECT_STDOUT_PATH.lstrip("/")).read_text(),
                "framed-result\n",
            )
            self.assertEqual(
                (root / relay.SUBJECT_STDERR_PATH.lstrip("/")).read_text(),
                "diagnostic\n",
            )
            self.assertEqual(result.stdout, "framed-result\n")


if __name__ == "__main__":
    unittest.main()
