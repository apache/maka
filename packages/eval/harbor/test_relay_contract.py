import asyncio
import importlib
import os
import shlex
import subprocess
import sys
import tempfile
import types
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch


class BaseAgent:
    def __init__(self, *args, **kwargs):
        pass


class Environment:
    def __init__(self, stage_upload: bool = False):
        self.uploaded = b""
        self.uploaded_target = None
        self.stage_upload = stage_upload

    async def upload_file(self, source: Path, target: str) -> None:
        self.uploaded = source.read_bytes()
        if self.stage_upload:
            self.uploaded_target = Path(target)
            self.uploaded_target.write_bytes(self.uploaded)


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


class RelayContractTest(unittest.TestCase):
    def test_stages_environment_and_discards_unstructured_stdout(self):
        relay = load_relay()
        environment = Environment()
        command = asyncio.run(
            relay._prepare_command(
                environment,
                {
                    "command": "/opt/agent",
                    "args": ["run"],
                    "environment": {"MODE": "offline"},
                    "credentials": {"API_KEY": "canary-secret"},
                    "captureStdout": False,
                },
                "token",
                "/tmp/scope.pid",
            )
        )

        self.assertIn(b"export MODE=offline", environment.uploaded)
        self.assertIn(b"export API_KEY=canary-secret", environment.uploaded)
        self.assertNotIn("canary-secret", command)
        self.assertIn(">/dev/null", command)

    def test_leaves_no_credential_file_when_command_preparation_fails(self):
        relay = load_relay()
        environment = Environment()
        named_temporary_file = tempfile.NamedTemporaryFile
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(
                relay.tempfile,
                "NamedTemporaryFile",
                side_effect=lambda *args, **kwargs: named_temporary_file(
                    *args, dir=directory, **kwargs
                ),
            ):
                with self.assertRaisesRegex(RuntimeError, "invalid Maka Eval credential name"):
                    asyncio.run(
                        relay._prepare_command(
                            environment,
                            {
                                "command": "/opt/agent",
                                "args": ["run"],
                                "environment": {"MODE": "offline"},
                                "credentials": {
                                    "API_KEY": "canary-secret",
                                    "BAD-NAME": "ignored",
                                },
                                "captureStdout": False,
                            },
                            "token",
                            "/tmp/scope.pid",
                        )
                    )
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_removes_credential_file_when_subject_overrides_path(self):
        relay = load_relay()
        environment = Environment(stage_upload=True)
        token = f"contract-{uuid.uuid4().hex}"
        with tempfile.TemporaryDirectory() as directory:
            command = asyncio.run(
                relay._prepare_command(
                    environment,
                    {
                        "command": "/bin/sh",
                        "args": ["-c", "exit 0"],
                        "environment": {"PATH": "/definitely-missing"},
                        "credentials": {"API_KEY": "canary-secret"},
                        "captureStdout": True,
                    },
                    token,
                    str(Path(directory) / "scope.pid"),
                )
            )
            target = environment.uploaded_target
            self.assertIsNotNone(target)
            try:
                completed = subprocess.run(
                    ["/bin/sh", "-c", shlex.split(command)[-1]],
                    check=False,
                    capture_output=True,
                    text=True,
                )
                self.assertEqual(completed.returncode, 0, completed.stderr)
                self.assertFalse(target.exists())
            finally:
                target.unlink(missing_ok=True)


if __name__ == "__main__":
    unittest.main()
