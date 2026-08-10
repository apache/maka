import importlib
import os
import sys
import types
import unittest
from pathlib import Path


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


if __name__ == "__main__":
    unittest.main()
