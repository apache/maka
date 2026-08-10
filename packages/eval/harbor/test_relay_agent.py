import importlib
import asyncio
import json
import os
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch


class BaseAgent:
    def __init__(self, *args, **kwargs):
        pass


def load_relay(framework: str):
    os.environ["MAKA_EVAL_FRAMEWORK"] = framework
    package = types.ModuleType(framework)
    agents = types.ModuleType(f"{framework}.agents")
    base = types.ModuleType(f"{framework}.agents.base")
    base.BaseAgent = BaseAgent
    sys.modules[framework] = package
    sys.modules[f"{framework}.agents"] = agents
    sys.modules[f"{framework}.agents.base"] = base
    sys.modules.pop("relay_agent", None)
    return importlib.import_module("relay_agent")


class FakeEnvironment:
    def __init__(self):
        self.uploaded = b""
        self.source = None

    async def upload_file(self, source, target):
        self.source = Path(source)
        self.uploaded = self.source.read_bytes()

    async def exec(self, command, cwd):
        return types.SimpleNamespace(return_code=0, stdout="result")


class RaceReader:
    def __init__(self, execute):
        self.lines = asyncio.Queue()
        self.lines.put_nowait(json.dumps(execute).encode() + b"\n")
        self.calls = 0

    async def readline(self):
        self.calls += 1
        if self.calls > 2:
            return b""
        return await self.lines.get()


class RaceWriter:
    def __init__(self, reader, token):
        self.reader = reader
        self.token = token
        self.last = None

    def write(self, value):
        self.last = json.loads(value)

    async def drain(self):
        if self.last["kind"] == "executed":
            await self.reader.lines.put(
                json.dumps({"token": self.token, "kind": "verify"}).encode() + b"\n"
            )
            await asyncio.sleep(0)

    def close(self):
        pass

    async def wait_closed(self):
        pass


class TimeoutEnvironment(FakeEnvironment):
    def __init__(self):
        super().__init__()
        self.started = asyncio.Event()
        self.release = asyncio.Event()

    async def exec(self, command, cwd, **_kwargs):
        if command == "/cancel":
            self.release.set()
            return types.SimpleNamespace(return_code=0, stdout="")
        self.started.set()
        await self.release.wait()
        return types.SimpleNamespace(return_code=0, stdout="settled")


class QueueWriter:
    def __init__(self):
        self.messages = []

    def write(self, value):
        self.messages.append(json.loads(value))

    async def drain(self):
        pass

    def close(self):
        pass

    async def wait_closed(self):
        pass


class RelayAgentTest(unittest.IsolatedAsyncioTestCase):
    async def test_credential_is_staged_without_entering_the_command_line(self):
        relay = load_relay("harbor")
        environment = FakeEnvironment()
        secret = "canary-secret-value"
        command = await relay._prepare_command(
            environment,
            {
                "command": "/opt/agent",
                "args": ["run"],
                "credentials": {"OPENAI_API_KEY": secret},
            },
            "token",
            "/tmp/scope.pid",
        )

        self.assertNotIn(secret, command)
        self.assertIn(secret.encode(), environment.uploaded)
        self.assertFalse(environment.source.exists())

    def test_framework_selection_is_explicit(self):
        harbor = load_relay("harbor")
        pier = load_relay("pier")
        self.assertTrue(issubclass(harbor.RelayAgent, BaseAgent))
        self.assertTrue(issubclass(pier.RelayAgent, BaseAgent))

    async def test_verify_consumed_while_reporting_execution_is_not_lost(self):
        relay = load_relay("harbor")
        token = "token"
        reader = RaceReader(
            {
                "token": token,
                "kind": "execute",
                "command": "/opt/agent",
                "args": [],
                "cwd": "/app",
                "credentials": {},
            }
        )
        writer = RaceWriter(reader, token)

        async def open_connection(_host, _port):
            return reader, writer

        agent = relay.RelayAgent(relay_host="127.0.0.1", relay_port=1, relay_token=token)
        with patch.object(relay.asyncio, "open_connection", open_connection):
            await agent.run("solve", FakeEnvironment(), None)

        self.assertEqual(reader.calls, 2)

    async def test_framework_timeout_is_reported_as_an_explicit_termination(self):
        relay = load_relay("harbor")
        token = "token"
        reader = RaceReader(
            {
                "token": token,
                "kind": "execute",
                "command": "/opt/agent",
                "args": [],
                "cwd": "/app",
                "credentials": {},
                "cancel": {"command": "/cancel", "args": []},
            }
        )
        writer = QueueWriter()
        environment = TimeoutEnvironment()

        async def open_connection(_host, _port):
            return reader, writer

        agent = relay.RelayAgent(relay_host="127.0.0.1", relay_port=1, relay_token=token)
        with patch.object(relay.asyncio, "open_connection", open_connection):
            execution = asyncio.create_task(agent.run("solve", environment, None))
            await environment.started.wait()
            execution.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await execution

        executed = next(message for message in writer.messages if message["kind"] == "executed")
        self.assertEqual(executed["termination"], "framework_timeout")


if __name__ == "__main__":
    unittest.main()
