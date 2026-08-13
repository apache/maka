import asyncio
import base64
import hashlib
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


def load_relay(framework="harbor"):
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


class RelayContractTest(unittest.TestCase):
    def test_merged_noise_cannot_corrupt_or_escape_the_result_frame(self):
        relay = load_relay()
        token = "frame-token"
        payload = b'{"kind":"settled","status":"completed"}'
        encoded = base64.urlsafe_b64encode(payload).decode().rstrip("=")
        frame = (
            f"MAKA-EVAL-RESULT-V1 {token} {len(payload)} "
            f"{hashlib.sha256(payload).hexdigest()} {encoded}\n"
        )
        sentinel = "credential-sentinel-must-not-persist"

        stdout, diagnostic = relay._decode_result_carrier(
            f"docker warning\n{frame}{sentinel}\n", token
        )

        self.assertEqual(stdout, payload.decode())
        self.assertEqual(diagnostic["category"], "unstructured-output")
        self.assertEqual(
            diagnostic["bytes"], len(f"docker warning\n{sentinel}\n".encode())
        )
        self.assertNotIn(sentinel, str({"stdout": stdout, "diagnostic": diagnostic}))

    def test_invalid_result_frames_fail_closed_with_bounded_evidence(self):
        relay = load_relay()
        token = "frame-token"
        payload = b"{}"
        encoded = base64.urlsafe_b64encode(payload).decode().rstrip("=")
        valid = (
            f"MAKA-EVAL-RESULT-V1 {token} {len(payload)} "
            f"{hashlib.sha256(payload).hexdigest()} {encoded}\n"
        )
        cases = {
            "noise only": "result-frame-missing",
            valid + valid: "result-frame-ambiguous",
            valid.replace(hashlib.sha256(payload).hexdigest(), "0" * 64): "result-frame-invalid",
        }
        for carrier, category in cases.items():
            with self.subTest(category=category):
                stdout, diagnostic = relay._decode_result_carrier(carrier, token)
                self.assertEqual(stdout, "")
                self.assertEqual(diagnostic["category"], category)
                self.assertEqual(set(diagnostic), {"category", "bytes", "sha256"})

    def test_non_utf8_result_payload_is_classified_as_an_invalid_frame(self):
        relay = load_relay()
        token = "frame-token"
        payload = b"\xff"
        encoded = base64.urlsafe_b64encode(payload).decode().rstrip("=")
        frame = (
            f"MAKA-EVAL-RESULT-V1 {token} {len(payload)} "
            f"{hashlib.sha256(payload).hexdigest()} {encoded}\n"
        )

        stdout, diagnostic = relay._decode_result_carrier(frame, token)

        self.assertEqual(stdout, "")
        self.assertEqual(diagnostic["category"], "result-frame-invalid")

    def test_oversized_result_carrier_is_rejected_before_parsing(self):
        relay = load_relay()
        carrier = "x" * (relay.RESULT_CARRIER_LIMIT_BYTES + 1)
        stdout, diagnostic = relay._decode_result_carrier(carrier, "frame-token")
        self.assertEqual(stdout, "")
        self.assertEqual(diagnostic["category"], "result-frame-oversize")

    def test_subject_output_cannot_counterfeit_scope_setup_failure(self):
        relay = load_relay()
        token = "0" * 32
        carrier = f"subject output\nMAKA-EVAL-SCOPE-ERROR-V1 {token}\n"

        _, diagnostic = relay._project_result(
            types.SimpleNamespace(stdout=carrier),
            {"captureStdout": False, "resultToken": token},
        )

        self.assertEqual(diagnostic["category"], "none")

    def test_command_keeps_capture_and_control_files_out_of_task_workspace(self):
        relay = load_relay()
        environment = Environment()
        command = asyncio.run(
            relay._prepare_command(
                environment,
                {
                    "command": "/opt/agent",
                    "args": ["run"],
                    "environment": {},
                    "credentials": {},
                    "captureStdout": True,
                    "resultToken": "0" * 32,
                },
                "token",
                "/logs/agent/.maka-eval-token.pid",
            )
        )

        self.assertNotIn(".stdout", command)
        self.assertNotIn(".stderr", command)
        self.assertNotIn("/app", command)
        self.assertIn("/logs/agent/.maka-eval-token.pid", command)
        self.assertIn("2>/dev/null", command)

    def test_command_does_not_start_subject_when_scope_pid_cannot_be_published(self):
        relay = load_relay()
        environment = Environment(stage_upload=True)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            fake_bin = root / "bin"
            fake_bin.mkdir()
            fake_setsid = fake_bin / "setsid"
            fake_setsid.write_text(
                "#!/bin/sh\n"
                "if [ \"$1\" = --wait ]; then shift; fi\n"
                "exec \"$@\"\n"
            )
            fake_setsid.chmod(0o755)
            marker = root / "subject-started"
            scope_path = root / "missing" / "scope.pid"
            command = asyncio.run(
                relay._prepare_command(
                    environment,
                    {
                        "command": "/bin/sh",
                        "args": ["-c", f"touch {shlex.quote(str(marker))}"],
                        "environment": {},
                        "credentials": {},
                        "captureStdout": False,
                        "resultToken": "0" * 32,
                    },
                    "token",
                    str(scope_path),
                )
            )
            try:
                completed = subprocess.run(
                    command,
                    shell=True,
                    check=False,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    env={**os.environ, "PATH": f"{fake_bin}:{os.environ['PATH']}"},
                )
                self.assertFalse(marker.exists())
            finally:
                if environment.uploaded_target is not None:
                    environment.uploaded_target.unlink(missing_ok=True)

        self.assertNotEqual(completed.returncode, 0)
        stdout, diagnostic = relay._project_result(
            types.SimpleNamespace(stdout=completed.stdout.decode()),
            {"captureStdout": False, "resultToken": "0" * 32},
        )
        self.assertEqual(stdout, "")
        self.assertEqual(diagnostic["category"], "execution-scope-unavailable")

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
                    "resultToken": "0" * 32,
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
                                "resultToken": "0" * 32,
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
                        "resultToken": "0" * 32,
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
