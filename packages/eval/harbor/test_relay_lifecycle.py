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
import base64
import contextlib
import hashlib
import importlib
import json
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


class LiveScopeEnvironment(SimultaneousEnvironment):
    """A subject whose process group outlives it, as a task's own service does."""

    def __init__(self):
        super().__init__()
        self.signalled = False
        self.commands = []

    async def exec(self, command, cwd=None, timeout_sec=None):
        self.commands.append(command)
        if _is_teardown(command):
            self.signalled = True
            return SimpleNamespace(return_code=0, stdout="", stderr="")
        if command.startswith("pgid="):
            return SimpleNamespace(return_code=3 if self.signalled else 0, stdout="", stderr="")
        return await super().exec(command, cwd=cwd, timeout_sec=timeout_sec)


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


def _is_teardown(command: str) -> bool:
    # `kill -0` is how the relay asks whether the scope is still there; only
    # TERM and KILL end it.
    return "kill -TERM" in command or "kill -KILL" in command


class RecordingEnvironment:
    """Runs a subject that exits with a chosen code and records every command."""

    def __init__(self, return_code, status):
        self.return_code = return_code
        self.status = status
        self.signalled = False
        self.commands = []

    async def upload_file(self, source, target):
        return None

    async def download_file(self, source, target):
        shutil.copyfile(source, target)

    async def exec(self, command, cwd=None, timeout_sec=None):
        self.commands.append(command)
        if command.startswith("printf ") and "MAKA-EVAL-CWD-V1" in command:
            prefix = command.split("'", 2)[1]
            return SimpleNamespace(return_code=0, stdout=f"{prefix}/workspace\n", stderr=None)
        if command.startswith("setsid"):
            payload = ('{"kind":"settled","status":"%s"}' % self.status).encode()
            encoded = base64.urlsafe_b64encode(payload).decode().rstrip("=")
            frame = (
                f"MAKA-EVAL-RESULT-V1 {'0' * 32} {len(payload)} "
                f"{hashlib.sha256(payload).hexdigest()} {encoded}\n"
            )
            return SimpleNamespace(return_code=self.return_code, stdout=frame, stderr=None)
        # The subject's process group outlives it, as a task's own service does,
        # and dies once something signals it. A teardown would therefore succeed
        # here rather than fail for its own reasons -- what this test asserts is
        # that no teardown is attempted at all.
        if _is_teardown(command):
            self.signalled = True
            return SimpleNamespace(return_code=0, stdout="", stderr="")
        if command.startswith("pgid="):
            return SimpleNamespace(return_code=3 if self.signalled else 0, stdout="", stderr="")
        return SimpleNamespace(return_code=0, stdout="", stderr="")


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
        environment = LiveScopeEnvironment()
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
            # Cancellation found the subject already stopped, and a stopped
            # subject is reported as one -- so the verifier reads the same
            # environment it would have read without the cancellation. Tearing
            # its scope down here would edit that environment for exactly the
            # runs the framework happened to interrupt.
            self.assertEqual(
                [command for command in environment.commands if _is_teardown(command)],
                [],
            )
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

    async def test_an_exited_subject_is_left_alone_whatever_it_reported(self):
        # The verifier scores the environment the task was left in, so a subject
        # that stopped on its own keeps whatever it started — a service the task
        # was asked to run has to still be there. Reading the exit code here to
        # decide otherwise would make the measurement depend on the framework's
        # own classification, and only for the subjects it classifies as failed.
        for return_code, status in ((0, "completed"), (1, "failed")):
            with self.subTest(return_code=return_code):
                relay = load_relay()
                environment = RecordingEnvironment(return_code, status)
                token = f"exited-{return_code}-{os.getpid()}"
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
                            json.dumps(
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
                    executed = json.loads(await reader.readline())
                    self.assertEqual(executed["termination"], "exited")
                    self.assertEqual(executed["exitCode"], return_code)
                    writer.write(
                        (json.dumps({"token": token, "kind": "verify"}) + "\n").encode()
                    )
                    await writer.drain()
                    await asyncio.wait_for(running, timeout=2)
                finally:
                    writer.close()
                    with contextlib.suppress(Exception):
                        await writer.wait_closed()
                    server.close()
                    await server.wait_closed()
                self.assertEqual(
                    [command for command in environment.commands if _is_teardown(command)],
                    [],
                )

    @unittest.skipUnless(shutil.which("node"), "requires Node.js")
    def test_deepseek_harness_toolchain_patch_preserves_background_descendants(self):
        patcher = (
            Path(__file__).parent
            / "deepseek-harness-toolchain"
            / "patch-subprocess-local.mjs"
        )
        with tempfile.TemporaryDirectory() as directory:
            target = (
                Path(directory)
                / "node_modules"
                / "@deepseek-ai"
                / "dsh-subprocess-local"
                / "lib"
                / "index.js"
            )
            target.parent.mkdir(parents=True)
            target.write_text(
                """\
\tterminateForHostExit() {
\t\tthis.forceStopDescendants();
\t\tthis.forceStopShell();
\t\tthis.forceStopDescendants();
\t}
\tasync closeOnce() {
\t\tlet survivors = await this.stopDescendants();
\t\tif (survivors.length > 0) throw new Error(`terminal cleanup failed; surviving pids: ${survivors.map((member) => member.pid).join(", ")}`);
\t\tawait this.stopShell();
\t\tsurvivors = await this.stopDescendants();
\t\tif (survivors.length > 0) throw new Error(`terminal cleanup failed; surviving pids: ${survivors.map((member) => member.pid).join(", ")}`);
\t\tthis.dataDisposable.dispose();
\t\tthis.exitDisposable.dispose();
\t}
"""
            )
            subprocess.run(
                [shutil.which("node"), patcher, directory],
                check=True,
                capture_output=True,
                text=True,
            )
            patched = target.read_text()
            self.assertEqual(
                patched.count('process.env.DSH_PRESERVE_BACKGROUND_PROCESSES === "1"'),
                2,
            )
            self.assertIn("this.forceStopShell();\n\t\t\treturn;", patched)
            self.assertIn("await this.stopShell();", patched)

            # The value of this patcher is that an upstream release it no longer
            # understands stops the build rather than producing a toolchain that
            # silently kills the task's services again. Running it over its own
            # output is the cheapest form of drift: the text it anchors on is
            # gone.
            drifted = subprocess.run(
                [shutil.which("node"), patcher, directory],
                capture_output=True,
                text=True,
            )
            self.assertNotEqual(drifted.returncode, 0)
            self.assertNotEqual(target.read_text(), "")


if __name__ == "__main__":
    unittest.main()
