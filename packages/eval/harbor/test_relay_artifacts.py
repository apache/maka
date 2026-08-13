import asyncio
import importlib
import os
import shutil
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
