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


class SimultaneousEnvironment:
    def __init__(self):
        self.release = asyncio.Event()

    async def upload_file(self, source, target):
        shutil.copyfile(source, target)

    async def download_file(self, source, target):
        shutil.copyfile(source, target)

    async def exec(self, command, cwd=None, timeout_sec=None):
        if command == "pwd":
            return SimpleNamespace(return_code=0, stdout="/workspace\n", stderr="")
        if command.startswith("setsid"):
            await self.release.wait()
            return SimpleNamespace(return_code=0, stdout="", stderr="")
        if command.startswith("test -r"):
            return SimpleNamespace(return_code=1, stdout="", stderr="")
        return SimpleNamespace(return_code=0, stdout="", stderr="")


class ClosedWriter:
    def is_closing(self):
        return False

    def write(self, _value):
        raise BrokenPipeError

    async def drain(self):
        raise AssertionError("drain must not run after a failed write")


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
    async def test_closed_peer_is_a_bounded_transport_outcome(self):
        relay = load_relay()
        delivered = await relay._send(ClosedWriter(), {"kind": "verify"})
        self.assertFalse(delivered)

    async def test_terminal_execution_wins_when_cancel_completes_simultaneously(self):
        relay = load_relay()
        environment = SimultaneousEnvironment()
        token = f"simultaneous-{os.getpid()}"
        connected = asyncio.get_running_loop().create_future()

        async def accept(reader, writer):
            connected.set_result((reader, writer))

        server = await asyncio.start_server(accept, "127.0.0.1", 0)
        port = server.sockets[0].getsockname()[1]
        agent = relay.RelayAgent(
            logs_dir=Path(tempfile.gettempdir()),
            relay_host="127.0.0.1",
            relay_port=port,
            relay_token=token,
        )
        running = asyncio.create_task(agent.run("solve", environment, None))
        reader, writer = await connected
        try:
            ready = __import__("json").loads(await reader.readline())
            self.assertEqual(ready["kind"], "ready")
            self.assertEqual(ready["cwd"], "/workspace")
            writer.write(
                (
                    __import__("json").dumps(
                        {
                            "token": token,
                            "kind": "execute",
                            "command": "/bin/true",
                            "args": [],
                            "credentials": {},
                        }
                    )
                    + "\n"
                    + __import__("json").dumps({"token": token, "kind": "cancel"})
                    + "\n"
                ).encode()
            )
            await writer.drain()
            environment.release.set()
            executed = __import__("json").loads(await reader.readline())
            self.assertEqual(executed["termination"], "exited")
            self.assertEqual(executed["exitCode"], 0)
            writer.write(
                (__import__("json").dumps({"token": token, "kind": "verify"}) + "\n").encode()
            )
            await writer.drain()
            await running
        finally:
            writer.close()
            await writer.wait_closed()
            server.close()
            await server.wait_closed()
            Path(f"/tmp/maka-eval-{token}.env").unlink(missing_ok=True)

    async def test_scope_waits_for_child_and_publishes_bounded_stdout(self):
        relay = load_relay()
        environment = LocalEnvironment()
        token = f"test-{os.getpid()}"
        scope_path = f"/tmp/maka-eval-{token}.pid"
        request = {
            "command": "/bin/sh",
            "args": ["-c", "sleep 0.1; printf result-json"],
            "credentials": {},
        }
        try:
            command = await relay._prepare_command(environment, request, token, scope_path)
            started = time.monotonic()
            result = subprocess.run(
                command,
                cwd=tempfile.gettempdir(),
                shell=True,
                check=False,
                timeout=2,
                capture_output=True,
                text=True,
            )
            self.assertEqual(result.returncode, 0)
            self.assertGreaterEqual(time.monotonic() - started, 0.09)
            self.assertEqual(result.stdout, "result-json")
        finally:
            Path(scope_path).unlink(missing_ok=True)

    async def test_settle_kills_descendants_before_verification_boundary(self):
        relay = load_relay()
        environment = LocalEnvironment()
        token = f"descendant-{os.getpid()}"
        scope_path = f"/tmp/maka-eval-{token}.pid"
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
                command = await relay._prepare_command(environment, request, token, scope_path)
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
                result = await relay._settle(
                    environment, request, directory, scope_path, execution
                )
                self.assertEqual(result.returncode, 0)
                await asyncio.sleep(0.4)
                self.assertFalse(late_write.exists())
            finally:
                Path(scope_path).unlink(missing_ok=True)


if __name__ == "__main__":
    unittest.main()
