import asyncio
import importlib
import os
import shutil
import subprocess
import sys
import tempfile
import time
import types
import unittest
from pathlib import Path
from types import SimpleNamespace


class BaseAgent:
    def __init__(self, *args, **kwargs):
        pass


class LocalEnvironment:
    async def upload_file(self, source, target):
        shutil.copyfile(source, target)

    async def download_file(self, source, target):
        shutil.copyfile(source, target)

    async def exec(self, command, cwd=None, timeout_sec=None):
        completed = await asyncio.to_thread(
            subprocess.run,
            command,
            cwd=cwd,
            shell=True,
            executable="/bin/bash",
            check=False,
            timeout=timeout_sec,
        )
        return SimpleNamespace(return_code=completed.returncode)


def load_relay():
    os.environ["MAKA_EVAL_FRAMEWORK"] = "harbor"
    package = types.ModuleType("harbor")
    agents = types.ModuleType("harbor.agents")
    base = types.ModuleType("harbor.agents.base")
    base.BaseAgent = BaseAgent
    sys.modules["harbor"] = package
    sys.modules["harbor.agents"] = agents
    sys.modules["harbor.agents.base"] = base
    sys.modules.pop("relay_agent", None)
    return importlib.import_module("relay_agent")


class RelayLifecycleTest(unittest.IsolatedAsyncioTestCase):
    async def test_scope_waits_for_child_and_publishes_bounded_stdout(self):
        relay = load_relay()
        environment = LocalEnvironment()
        token = f"test-{os.getpid()}"
        scope_path = f"/tmp/maka-eval-{token}.pid"
        output_path = f"/tmp/maka-eval-{token}.stdout"
        request = {
            "command": "/bin/sh",
            "args": ["-c", "sleep 0.1; printf result-json"],
            "credentials": {},
        }
        try:
            command = await relay._prepare_command(
                environment, request, token, scope_path, output_path
            )
            started = time.monotonic()
            result = subprocess.run(
                command,
                cwd=tempfile.gettempdir(),
                shell=True,
                check=False,
                timeout=2,
            )
            self.assertEqual(result.returncode, 0)
            self.assertGreaterEqual(time.monotonic() - started, 0.09)
            self.assertEqual(
                await relay._read_subject_output(environment, output_path),
                "result-json",
            )
        finally:
            Path(scope_path).unlink(missing_ok=True)
            Path(output_path).unlink(missing_ok=True)

    async def test_settle_kills_descendants_before_verification_boundary(self):
        relay = load_relay()
        environment = LocalEnvironment()
        token = f"descendant-{os.getpid()}"
        scope_path = f"/tmp/maka-eval-{token}.pid"
        output_path = f"/tmp/maka-eval-{token}.stdout"
        with tempfile.TemporaryDirectory() as directory:
            late_write = Path(directory) / "late-write"
            request = {
                "command": sys.executable,
                "args": [
                    "-c",
                    (
                        "import os,time;"
                        "child=os.fork();"
                        f"(time.sleep(0.3),open({str(late_write)!r},'w').write('late'),os._exit(0))"
                        " if child==0 else os._exit(0)"
                    ),
                ],
                "credentials": {},
                "cwd": directory,
            }
            try:
                command = await relay._prepare_command(
                    environment, request, token, scope_path, output_path
                )
                execution = asyncio.create_task(
                    asyncio.to_thread(
                        subprocess.run,
                        command,
                        cwd=directory,
                        shell=True,
                        check=False,
                        timeout=2,
                    )
                )
                deadline = time.monotonic() + 1
                while True:
                    scope = Path(scope_path)
                    pid = scope.read_text().strip() if scope.exists() else ""
                    if pid.isdigit():
                        break
                    if time.monotonic() >= deadline:
                        self.fail("scope PID was not published")
                    await asyncio.sleep(0.01)
                completed = await execution
                self.assertEqual(completed.returncode, 0)
                result = await relay._settle(environment, request, scope_path, execution)
                self.assertEqual(result.returncode, 0)
                await asyncio.sleep(0.4)
                self.assertFalse(late_write.exists())
            finally:
                Path(scope_path).unlink(missing_ok=True)
                Path(output_path).unlink(missing_ok=True)


if __name__ == "__main__":
    unittest.main()
