import asyncio
import base64
import contextlib
import hashlib
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
        if target.startswith("/logs/"):
            return
        shutil.copyfile(source, target)

    async def download_file(self, source, target):
        shutil.copyfile(source, target)

    async def exec(self, command, cwd=None, timeout_sec=None):
        if command.startswith("mkdir -p /logs/artifacts"):
            return SimpleNamespace(return_code=0, stdout="", stderr="")
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
        self.started = asyncio.Event()
        self.finished = asyncio.Event()

    async def upload_file(self, source, target):
        if target.startswith("/logs/"):
            return
        shutil.copyfile(source, target)

    async def download_file(self, source, target):
        shutil.copyfile(source, target)

    async def exec(self, command, cwd=None, timeout_sec=None):
        if command.startswith("printf ") and "MAKA-EVAL-CWD-V1" in command:
            prefix = command.split("'", 2)[1]
            return SimpleNamespace(
                return_code=0, stdout=f"docker warning\n{prefix}/workspace\n", stderr=None
            )
        if command.startswith("setsid"):
            self.started.set()
            await self.release.wait()
            payload = b'{"kind":"settled"}'
            encoded = base64.urlsafe_b64encode(payload).decode().rstrip("=")
            frame = (
                f"MAKA-EVAL-RESULT-V1 {'0' * 32} {len(payload)} "
                f"{hashlib.sha256(payload).hexdigest()} {encoded}\n"
            )
            self.finished.set()
            return SimpleNamespace(return_code=0, stdout=frame, stderr=None)
        if command.startswith("test -r") or command.startswith("pgid="):
            return SimpleNamespace(return_code=3, stdout="", stderr="")
        return SimpleNamespace(return_code=0, stdout="", stderr="")


class ClosedWriter:
    def is_closing(self):
        return False

    def write(self, _value):
        raise BrokenPipeError

    async def drain(self):
        raise AssertionError("drain must not run after a failed write")


class HangingStopEnvironment:
    async def stop(self, delete=False):
        await asyncio.Future()


class ScopeEvidenceEnvironment:
    def __init__(self, return_code):
        self.return_code = return_code

    async def exec(self, command, cwd=None, timeout_sec=None):
        return SimpleNamespace(return_code=self.return_code, stdout="", stderr="")


class ScopeSetupFailureEnvironment:
    async def upload_file(self, source, target):
        return None

    async def exec(self, command, cwd=None, timeout_sec=None):
        if command.startswith("printf ") and "MAKA-EVAL-CWD-V1" in command:
            prefix = command.split("'", 2)[1]
            return SimpleNamespace(return_code=0, stdout=f"{prefix}/workspace\n", stderr=None)
        if command.startswith("setsid"):
            token = "0" * 32
            return SimpleNamespace(
                return_code=111,
                stdout=f"MAKA-EVAL-SCOPE-ERROR-V1 {token}\n",
                stderr=None,
            )
        if command.startswith("rm -f --"):
            return SimpleNamespace(return_code=0, stdout="", stderr="")
        if command.startswith("mkdir -p /logs/artifacts"):
            return SimpleNamespace(return_code=0, stdout="", stderr="")
        raise AssertionError(f"unexpected command after scope setup failure: {command}")


class FrameworkTimeoutEnvironment(SimultaneousEnvironment):
    def __init__(self):
        super().__init__()
        self.stopped = False

    async def exec(self, command, cwd=None, timeout_sec=None):
        if command.startswith("setsid"):
            self.started.set()
            await asyncio.Future()
        return await super().exec(command, cwd=cwd, timeout_sec=timeout_sec)

    async def stop(self, delete=False):
        self.stopped = delete


class TransportLossEnvironment(SimultaneousEnvironment):
    async def exec(self, command, cwd=None, timeout_sec=None):
        if "kill -TERM" in command:
            self.release.set()
            return SimpleNamespace(return_code=0, stdout="", stderr=None)
        return await super().exec(command, cwd=cwd, timeout_sec=timeout_sec)


class SettleCompletionEnvironment(SimultaneousEnvironment):
    async def exec(self, command, cwd=None, timeout_sec=None):
        if "kill -TERM" in command:
            self.release.set()
            return SimpleNamespace(return_code=0, stdout="", stderr=None)
        return await super().exec(command, cwd=cwd, timeout_sec=timeout_sec)


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


def run_host_teardown_probe(marker: Path, fail_cleanup: bool) -> subprocess.CompletedProcess:
    cleanup_failure = 'raise RuntimeError("cleanup failed")' if fail_cleanup else ""
    script = f"""
import asyncio
import os
import signal
import sys
import types
from pathlib import Path

import run_trial as module

relay = types.ModuleType("relay_agent")
relay.request_host_teardown = lambda: None
sys.modules["relay_agent"] = relay

async def trial(*_args):
    try:
        asyncio.get_running_loop().call_soon(os.kill, os.getpid(), signal.SIGTERM)
        await asyncio.Future()
    finally:
        Path({str(marker)!r}).write_text("attempted")
        {cleanup_failure}

module.run_trial = trial
sys.argv = ["run_trial.py", "harbor", "test", "/tmp/test-config"]
asyncio.run(module.main())
"""
    return subprocess.run(
        [sys.executable, "-c", script],
        cwd=Path(__file__).parent,
        capture_output=True,
        text=True,
        check=False,
    )


class RelayLifecycleTest(unittest.IsolatedAsyncioTestCase):
    def test_host_teardown_exits_successfully_after_trial_unwinds(self):
        with tempfile.TemporaryDirectory() as directory:
            marker = Path(directory) / "cleanup-attempted"
            completed = run_host_teardown_probe(marker, False)
            self.assertEqual(completed.returncode, 0, completed.stderr)
            self.assertEqual(marker.read_text(), "attempted")

    def test_host_teardown_failure_remains_nonzero(self):
        with tempfile.TemporaryDirectory() as directory:
            marker = Path(directory) / "cleanup-attempted"
            completed = run_host_teardown_probe(marker, True)
            self.assertNotEqual(completed.returncode, 0)
            self.assertEqual(marker.read_text(), "attempted")

    async def test_scope_setup_failure_is_reported_without_quiescing_an_unknown_scope(self):
        relay = load_relay()
        environment = ScopeSetupFailureEnvironment()
        token = f"scope-setup-{os.getpid()}"
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
            teardown_timeout_ms=1_000,
        )
        running = asyncio.create_task(agent.run("solve", environment, None))
        reader, writer = await connected
        try:
            await reader.readline()
            writer.write(
                (__import__("json").dumps({
                    "token": token,
                    "kind": "execute",
                    "command": "/bin/true",
                    "args": [],
                    "credentials": {},
                    "captureStdout": False,
                    "resultToken": "0" * 32,
                }) + "\n").encode()
            )
            await writer.drain()
            executed = __import__("json").loads(await reader.readline())
            self.assertEqual(executed["exitCode"], 111)
            self.assertEqual(executed["diagnostic"]["category"], "execution-scope-unavailable")
            writer.write(
                (__import__("json").dumps({"token": token, "kind": "verify"}) + "\n").encode()
            )
            await writer.drain()
            await running
        finally:
            writer.close()
            server.close()
            await server.wait_closed()

    async def test_missing_scope_evidence_cannot_be_treated_as_quiescent(self):
        relay = load_relay()

        with self.assertRaisesRegex(RuntimeError, "scope evidence was unavailable"):
            await relay._scope_active(ScopeEvidenceEnvironment(4), "/", "/missing")
        self.assertFalse(await relay._scope_active(ScopeEvidenceEnvironment(3), "/", "/gone"))

    async def test_closed_peer_is_a_bounded_transport_outcome(self):
        relay = load_relay()
        delivered = await relay._send(ClosedWriter(), {"kind": "verify"})
        self.assertFalse(delivered)

    async def test_destroy_fallback_obeys_the_teardown_deadline(self):
        relay = load_relay()
        execution = asyncio.create_task(asyncio.sleep(60))
        try:
            await asyncio.wait_for(
                relay._settle_or_destroy(
                    HangingStopEnvironment(), "/", "/tmp/missing", execution, 0.01
                ),
                timeout=0.1,
            )
        finally:
            execution.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await execution

    async def test_peer_close_during_execution_triggers_bounded_settlement(self):
        relay = load_relay()
        environment = TransportLossEnvironment()
        token = f"transport-loss-{os.getpid()}"
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
            teardown_timeout_ms=1_000,
        )
        running = asyncio.create_task(agent.run("solve", environment, None))
        reader, writer = await connected
        try:
            await reader.readline()
            writer.write(
                (
                    __import__("json").dumps(
                        {
                            "token": token,
                            "kind": "execute",
                            "command": "/bin/true",
                            "args": [],
                            "credentials": {},
                            "resultToken": "0" * 32,
                        }
                    )
                    + "\n"
                ).encode()
            )
            await writer.drain()
            writer.close()
            await writer.wait_closed()
            await asyncio.wait_for(running, timeout=0.5)
            self.assertTrue(environment.release.is_set())
        finally:
            server.close()
            await server.wait_closed()

    async def test_terminal_execution_wins_when_framework_cancellation_is_observed(self):
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
            teardown_timeout_ms=110_000,
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
                            "resultToken": "0" * 32,
                        }
                    )
                    + "\n"
                ).encode()
            )
            await writer.drain()
            environment.release.set()
            await environment.finished.wait()
            relay.request_host_teardown()
            running.cancel()
            executed = __import__("json").loads(await reader.readline())
            self.assertEqual(executed["termination"], "exited")
            self.assertEqual(executed["exitCode"], 0)
            with self.assertRaises(asyncio.CancelledError):
                await running
        finally:
            writer.close()
            with contextlib.suppress(ConnectionError, asyncio.CancelledError):
                await writer.wait_closed()
            server.close()
            await server.wait_closed()
            Path(f"/tmp/maka-eval-{token}.env").unlink(missing_ok=True)

    async def test_framework_cancellation_remains_timeout_when_settlement_induces_exit(self):
        relay = load_relay()
        environment = SettleCompletionEnvironment()
        token = f"host-terminal-{os.getpid()}"
        connected = asyncio.get_running_loop().create_future()

        async def accept(reader, writer):
            connected.set_result((reader, writer))

        server = await asyncio.start_server(accept, "127.0.0.1", 0)
        port = server.sockets[0].getsockname()[1]
        agent = relay.RelayAgent(
            logs_dir=Path(tempfile.gettempdir()), relay_host="127.0.0.1",
            relay_port=port, relay_token=token, teardown_timeout_ms=1_000,
        )
        running = asyncio.create_task(agent.run("solve", environment, None))
        reader, writer = await connected
        try:
            await reader.readline()
            writer.write((__import__("json").dumps({
                "token": token, "kind": "execute", "command": "/bin/true", "args": [],
                "credentials": {}, "resultToken": "0" * 32,
            }) + "\n").encode())
            await writer.drain()
            await environment.started.wait()
            running.cancel()
            executed = __import__("json").loads(await asyncio.wait_for(reader.readline(), 0.5))
            self.assertEqual(executed["termination"], "framework_timeout")
            self.assertEqual(executed["exitCode"], 124)
            with self.assertRaises(asyncio.CancelledError):
                await running
        finally:
            writer.close()
            server.close()
            await server.wait_closed()

    async def test_framework_timeout_survives_destroy_fallback(self):
        relay = load_relay()
        environment = FrameworkTimeoutEnvironment()
        token = f"framework-destroy-{os.getpid()}"
        connected = asyncio.get_running_loop().create_future()

        async def accept(reader, writer):
            connected.set_result((reader, writer))

        server = await asyncio.start_server(accept, "127.0.0.1", 0)
        port = server.sockets[0].getsockname()[1]
        agent = relay.RelayAgent(
            logs_dir=Path(tempfile.gettempdir()), relay_host="127.0.0.1",
            relay_port=port, relay_token=token, teardown_timeout_ms=50,
        )
        running = asyncio.create_task(agent.run("solve", environment, None))
        reader, writer = await connected
        try:
            await reader.readline()
            writer.write((__import__("json").dumps({
                "token": token, "kind": "execute", "command": "/bin/true", "args": [],
                "credentials": {}, "resultToken": "0" * 32,
            }) + "\n").encode())
            await writer.drain()
            await environment.started.wait()
            running.cancel()
            executed = __import__("json").loads(await asyncio.wait_for(reader.readline(), 0.5))
            self.assertEqual(executed["termination"], "framework_timeout")
            self.assertEqual(executed["exitCode"], 124)
            self.assertEqual(executed["diagnostic"]["category"], "result-frame-missing")
            self.assertTrue(environment.stopped)
            with self.assertRaises(asyncio.CancelledError):
                await running
        finally:
            writer.close()
            server.close()
            await server.wait_closed()

    @unittest.skipUnless(shutil.which("setsid"), "requires GNU setsid")
    async def test_scope_waits_for_child_and_publishes_bounded_stdout(self):
        relay = load_relay()
        environment = LocalEnvironment()
        token = f"test-{os.getpid()}"
        scope_path = f"/tmp/maka-eval-{token}.pid"
        request = {
            "command": "/bin/sh",
            "args": ["-c", "sleep 0.1; printf result-json"],
            "credentials": {},
            "resultToken": "0" * 32,
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

    @unittest.skipUnless(shutil.which("setsid"), "requires GNU setsid")
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
                "resultToken": "0" * 32,
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
                result = await relay._settle(environment, directory, scope_path, execution)
                self.assertEqual(result.returncode, 0)
                await asyncio.sleep(0.4)
                self.assertFalse(late_write.exists())
            finally:
                Path(scope_path).unlink(missing_ok=True)


if __name__ == "__main__":
    unittest.main()
