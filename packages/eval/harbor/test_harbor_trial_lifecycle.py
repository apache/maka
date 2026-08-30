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

from __future__ import annotations

import asyncio
import importlib.metadata
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
import uuid
from pathlib import Path
from typing import Any


ENABLED = os.environ.get("MAKA_EVAL_HARBOR_LIFECYCLE_TEST") == "1"
HARBOR_VERSION = "0.20.0"
RELAY_TOKEN = "0" * 32
RESULT_TOKEN = "1" * 32
ROOT = Path(__file__).resolve().parent


@unittest.skipUnless(ENABLED, "real Harbor lifecycle test is opt-in")
class HarborTrialLifecycleTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        if shutil.which("docker") is None:
            raise AssertionError("Docker CLI is required for the real Harbor lifecycle test")
        if importlib.metadata.version("harbor") != HARBOR_VERSION:
            raise AssertionError(f"Harbor {HARBOR_VERSION} is required")
        _docker("info", "--format", "{{.ServerVersion}}")
        _docker("compose", "version")

        if str(ROOT) not in sys.path:
            sys.path.insert(0, str(ROOT))
        import eval_framework

        eval_framework.install("harbor")

    def setUp(self) -> None:
        import relay_agent

        relay_agent._host_teardown_requested = False

    def test_framework_timeout_preserves_background_for_verifier(self) -> None:
        asyncio.run(self._framework_timeout_preserves_background_for_verifier())

    def test_host_abort_destroys_background_environment(self) -> None:
        asyncio.run(self._host_abort_destroys_background_environment())

    async def _framework_timeout_preserves_background_for_verifier(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            task_dir = _write_task(root)
            exchange = RelayExchange(wait_for_verification=True)
            async with exchange.serve() as port:
                trial = await _create_trial(
                    task_dir,
                    root / "trials",
                    _trial_name("framework-timeout"),
                    port,
                    timeout_sec=1.0,
                )
                result = await asyncio.wait_for(trial.run(), timeout=120)

            self.assertIsNone(result.exception_info)
            self.assertIsNotNone(result.verifier_result)
            assert result.verifier_result is not None
            self.assertEqual(result.verifier_result.rewards, {"reward": 1.0})
            self.assertIsNotNone(exchange.executed)
            assert exchange.executed is not None
            self.assertEqual(exchange.executed["termination"], "framework_timeout")
            self.assertEqual(exchange.executed["exitCode"], 124)
            self.assertIsNone(exchange.error)
            self.assertEqual(_project_containers(trial.config.trial_name), [])

    async def _host_abort_destroys_background_environment(self) -> None:
        from relay_agent import request_host_teardown

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            task_dir = _write_task(root)
            trial_name = _trial_name("host-abort")
            exchange = RelayExchange(wait_for_verification=False)
            trial_task: asyncio.Task[Any] | None = None
            container_id: str | None = None
            async with exchange.serve() as port:
                trial = await _create_trial(
                    task_dir,
                    root / "trials",
                    trial_name,
                    port,
                    timeout_sec=60.0,
                )
                try:
                    trial_task = asyncio.create_task(trial.run())
                    await asyncio.wait_for(exchange.execute_sent.wait(), timeout=60)
                    container_id = await _wait_for_subject(trial_name)

                    request_host_teardown()
                    trial_task.cancel()
                    with self.assertRaises(asyncio.CancelledError):
                        await asyncio.wait_for(trial_task, timeout=30)
                    await _wait_for_container_removal(container_id)
                finally:
                    if trial_task is not None and not trial_task.done():
                        request_host_teardown()
                        trial_task.cancel()
                        try:
                            await asyncio.wait_for(trial_task, timeout=30)
                        except (asyncio.CancelledError, TimeoutError):
                            pass
                    _remove_project_containers(trial_name)

            self.assertIsNone(exchange.executed)
            self.assertIsNone(exchange.error)
            self.assertEqual(_project_containers(trial_name), [])


class RelayExchange:
    def __init__(self, *, wait_for_verification: bool):
        self.wait_for_verification = wait_for_verification
        self.execute_sent = asyncio.Event()
        self.executed: dict[str, Any] | None = None
        self.error: BaseException | None = None
        self._connections = 0
        self._server: asyncio.Server | None = None

    class _Serving:
        def __init__(self, exchange: RelayExchange):
            self.exchange = exchange

        async def __aenter__(self) -> int:
            server = await asyncio.start_server(self.exchange._handle, "127.0.0.1", 0)
            self.exchange._server = server
            socket = server.sockets[0]
            return int(socket.getsockname()[1])

        async def __aexit__(self, exc_type: Any, exc: Any, traceback: Any) -> None:
            assert self.exchange._server is not None
            self.exchange._server.close()
            await self.exchange._server.wait_closed()

    def serve(self) -> RelayExchange._Serving:
        return self._Serving(self)

    async def _handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        self._connections += 1
        try:
            if self._connections != 1:
                raise AssertionError("Harbor trial opened more than one relay connection")
            ready = await _read_message(reader)
            if ready.get("token") != RELAY_TOKEN or ready.get("kind") != "ready":
                raise AssertionError(f"invalid relay ready frame: {ready!r}")
            await _write_message(
                writer,
                {
                    "token": RELAY_TOKEN,
                    "kind": "execute",
                    "command": "/bin/sh",
                    "args": ["-c", _subject_script()],
                    "credentials": {},
                    "environment": {},
                    "resultToken": RESULT_TOKEN,
                    "captureStdout": True,
                },
            )
            self.execute_sent.set()
            if not self.wait_for_verification:
                await reader.read()
                return

            executed = await _read_message(reader)
            if executed.get("token") != RELAY_TOKEN or executed.get("kind") != "executed":
                raise AssertionError(f"invalid relay execution frame: {executed!r}")
            self.executed = executed
            await _write_message(writer, {"token": RELAY_TOKEN, "kind": "verify"})
            await reader.read()
        except BaseException as error:
            self.error = error
        finally:
            writer.close()
            await writer.wait_closed()


async def _create_trial(
    task_dir: Path,
    trials_dir: Path,
    trial_name: str,
    relay_port: int,
    *,
    timeout_sec: float,
) -> Any:
    from harbor.models.trial.config import TrialConfig
    from harbor.trial.trial import Trial

    config = TrialConfig.model_validate(
        {
            "task": {"path": str(task_dir)},
            "trial_name": trial_name,
            "trials_dir": str(trials_dir),
            "agent": {
                "import_path": "relay_agent:RelayAgent",
                "override_timeout_sec": timeout_sec,
                "kwargs": {
                    "relay_host": "127.0.0.1",
                    "relay_port": relay_port,
                    "relay_token": RELAY_TOKEN,
                    "teardown_timeout_ms": 5000,
                    "framework_timeout_ms": int(timeout_sec * 1000),
                },
            },
            "environment": {"type": "docker", "delete": True},
            "verifier": {"override_timeout_sec": 10},
        }
    )
    return await Trial.create(config)


def _write_task(root: Path) -> Path:
    task = root / "task"
    (task / "environment").mkdir(parents=True)
    (task / "tests").mkdir()
    (task / "instruction.md").write_text("Keep a background service running.\n")
    (task / "task.toml").write_text(
        '\n'.join(
            [
                'version = "1.0"',
                "",
                "[agent]",
                "timeout_sec = 60.0",
                "",
                "[verifier]",
                "timeout_sec = 10.0",
                "",
                "[environment]",
                "build_timeout_sec = 60.0",
                "",
            ]
        )
    )
    (task / "environment" / "Dockerfile").write_text(
        "FROM ubuntu:24.04\n"
        "RUN command -v setsid >/dev/null\n"
        "WORKDIR /app\n"
    )
    verifier = task / "tests" / "test.sh"
    verifier.write_text(
        "#!/bin/sh\n"
        "reward=0\n"
        "if test -s /tmp/maka-background.pid && "
        "kill -0 \"$(cat /tmp/maka-background.pid)\" 2>/dev/null; then\n"
        "  before=$(wc -c < /tmp/maka-background.heartbeat 2>/dev/null || printf 0)\n"
        "  sleep 0.4\n"
        "  after=$(wc -c < /tmp/maka-background.heartbeat 2>/dev/null || printf 0)\n"
        "  if test \"$after\" -gt \"$before\"; then reward=1; fi\n"
        "fi\n"
        "printf '%s\\n' \"$reward\" > /logs/verifier/reward.txt\n"
    )
    verifier.chmod(0o755)
    return task


def _subject_script() -> str:
    return (
        "trap 'exit 0' TERM; "
        "(trap '' TERM; while :; do printf x >> /tmp/maka-background.heartbeat; "
        "printf 'background-log\\n'; "
        "sleep 0.1; done) & "
        "child=$!; printf '%s\\n' \"$child\" > /tmp/maka-background.pid; "
        "while :; do sleep 1; done"
    )


async def _read_message(reader: asyncio.StreamReader) -> dict[str, Any]:
    raw = await asyncio.wait_for(reader.readline(), timeout=30)
    if not raw:
        raise AssertionError("relay connection closed before the expected frame")
    value = json.loads(raw)
    if not isinstance(value, dict):
        raise AssertionError(f"relay frame is not an object: {value!r}")
    return value


async def _write_message(writer: asyncio.StreamWriter, value: dict[str, Any]) -> None:
    writer.write(json.dumps(value, separators=(",", ":")).encode() + b"\n")
    await writer.drain()


async def _wait_for_subject(trial_name: str) -> str:
    deadline = asyncio.get_running_loop().time() + 60
    while asyncio.get_running_loop().time() < deadline:
        containers = _project_containers(trial_name)
        if len(containers) == 1:
            container_id = containers[0]
            ready = subprocess.run(
                ["docker", "exec", container_id, "sh", "-c", "test -s /tmp/maka-background.pid"],
                check=False,
                capture_output=True,
                text=True,
            )
            if ready.returncode == 0:
                return container_id
        await asyncio.sleep(0.1)
    raise AssertionError(f"subject did not start in Harbor project {trial_name!r}")


async def _wait_for_container_removal(container_id: str) -> None:
    deadline = asyncio.get_running_loop().time() + 20
    while asyncio.get_running_loop().time() < deadline:
        inspected = subprocess.run(
            ["docker", "inspect", container_id],
            check=False,
            capture_output=True,
            text=True,
        )
        if inspected.returncode != 0:
            return
        await asyncio.sleep(0.1)
    raise AssertionError(f"Harbor container {container_id} survived Host abort")


def _project_containers(trial_name: str) -> list[str]:
    project = f"{trial_name}__env"
    result = _docker(
        "ps",
        "--all",
        "--quiet",
        "--filter",
        f"label=com.docker.compose.project={project}",
        "--filter",
        "label=com.docker.compose.service=main",
    )
    return [line for line in result.splitlines() if line]


def _remove_project_containers(trial_name: str) -> None:
    containers = _project_containers(trial_name)
    if containers:
        _docker("rm", "--force", *containers)


def _docker(*args: str) -> str:
    completed = subprocess.run(
        ["docker", *args],
        check=True,
        capture_output=True,
        text=True,
        timeout=30,
    )
    return completed.stdout.strip()


def _trial_name(prefix: str) -> str:
    return f"maka-{prefix}-{uuid.uuid4().hex[:12]}"


if __name__ == "__main__":
    unittest.main()
