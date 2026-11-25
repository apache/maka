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
import importlib.util
import json
import logging
import os
import subprocess
import sys
import tempfile
import types
import unittest
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from unittest import mock

_AGENT_PATH = (
    Path(__file__).resolve().parent.parent / "harbor" / "maka_host_agent.py"
)


@dataclass
class _StubAgentContext:
    n_input_tokens: int | None = None
    n_cache_tokens: int | None = None
    n_output_tokens: int | None = None
    cost_usd: float | None = None


class _StubBaseEnvironment:
    pass


class _StubBaseAgent:
    def __init__(
        self, logs_dir: Path, model_name: str | None = None, **kwargs: object
    ) -> None:
        self.logs_dir = Path(logs_dir)
        self.environment_logs_dir = PurePosixPath("/logs/agent")
        self.model_name = model_name
        self.logger = logging.getLogger("test.maka_host_agent")


def _load_agent_module():
    stub_modules: dict[str, types.ModuleType] = {}

    def _mod(name: str) -> types.ModuleType:
        m = types.ModuleType(name)
        stub_modules[name] = m
        return m

    harbor_pkg = _mod("harbor")
    agents_pkg = _mod("harbor.agents")
    agents_base = _mod("harbor.agents.base")
    agents_base.BaseAgent = _StubBaseAgent
    env_pkg = _mod("harbor.environments")
    env_base = _mod("harbor.environments.base")
    env_base.BaseEnvironment = _StubBaseEnvironment
    models_pkg = _mod("harbor.models")
    models_agent = _mod("harbor.models.agent")
    models_ctx = _mod("harbor.models.agent.context")
    models_ctx.AgentContext = _StubAgentContext

    harbor_pkg.agents = agents_pkg
    harbor_pkg.environments = env_pkg
    harbor_pkg.models = models_pkg
    agents_pkg.base = agents_base
    env_pkg.base = env_base
    models_pkg.agent = models_agent
    models_agent.context = models_ctx

    saved = {name: sys.modules.get(name) for name in stub_modules}
    sys.modules.update(stub_modules)
    try:
        spec = importlib.util.spec_from_file_location(
            "maka_host_agent_under_test", _AGENT_PATH
        )
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    finally:
        for name, old in saved.items():
            if old is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = old


_MOD = _load_agent_module()
MakaHostAgent = _MOD.MakaHostAgent
MakaInfraError = _MOD.MakaInfraError


@dataclass
class _ExecResult:
    return_code: int = 0
    stdout: str | None = ""
    stderr: str | None = ""


class _FakeEnvironment:
    def __init__(self, *, mounted: bool = True) -> None:
        self.mounted = mounted
        self.exec_calls: list[dict[str, object]] = []
        self.uploaded_files: list[tuple[Path, str, str]] = []
        self.downloaded_files: list[tuple[str, Path]] = []
        self.prepared_logs = False

        self.exec_handler = None
        self.upload_error: BaseException | None = None
        self.prepare_error: BaseException | None = None
        self.download_handler = None

    async def exec(
        self,
        command: str,
        cwd: str | None = None,
        env: dict[str, str] | None = None,
        timeout_sec: int | None = None,
        user: str | int | None = None,
    ) -> _ExecResult:
        self.exec_calls.append(
            {
                "command": command,
                "cwd": cwd,
                "env": env,
                "timeout_sec": timeout_sec,
                "user": user,
            }
        )
        if self.exec_handler is not None:
            res = self.exec_handler(command, env=env, timeout_sec=timeout_sec, user=user)
            if isinstance(res, BaseException):
                raise res
            return res
        if command == "id -u && id -g":
            return _ExecResult(0, "1000\n1000\n", "")
        return _ExecResult(0, "", "")

    async def upload_file(self, source_path: Path | str, target_path: str) -> None:
        src = Path(source_path)
        self.uploaded_files.append((src, target_path, src.read_text(encoding="utf-8")))
        if self.upload_error is not None:
            raise self.upload_error

    async def download_file(self, source_path: str, target_path: Path | str) -> None:
        dst = Path(target_path)
        self.downloaded_files.append((source_path, dst))
        if self.download_handler is not None:
            self.download_handler(source_path, dst)

    def is_path_mounted(self, _container_path: PurePosixPath, _host_path: Path) -> bool:
        return self.mounted

    async def prepare_logs_for_host(self) -> None:
        self.prepared_logs = True
        if self.prepare_error is not None:
            raise self.prepare_error


def _make_agent(logs_dir: Path, **overrides: object) -> MakaHostAgent:
    kwargs: dict[str, object] = {
        "api_key_env": "MAKA_TEST_KEY",
        "provider": "deepseek",
        "model_id": "deepseek-chat",
        "sandbox_mode": "danger-full-access",
    }
    kwargs.update(overrides)
    return MakaHostAgent(logs_dir=logs_dir, model_name="deepseek/deepseek-chat", **kwargs)


def _valid_settlement(
    *,
    input_tokens: int | None = 100,
    cache_tokens: int | None = 20,
    output_tokens: int | None = 30,
    metering: object | None = None,
) -> dict[str, object]:
    if metering is None:
        metering = {"complete": {"costUsd": 0.0005}}
    settlement: dict[str, object] = {"metering": metering}
    if input_tokens is not None:
        settlement["inputTokens"] = input_tokens
    if cache_tokens is not None:
        settlement["cacheTokens"] = cache_tokens
    if output_tokens is not None:
        settlement["outputTokens"] = output_tokens
    return settlement


class MakaHostAgentTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.logs_dir = Path(self._tmp.name) / "logs"
        self.logs_dir.mkdir()
        self._prev_key = os.environ.get("MAKA_TEST_KEY")
        os.environ["MAKA_TEST_KEY"] = "sk-test-secret"

    def tearDown(self) -> None:
        if self._prev_key is None:
            os.environ.pop("MAKA_TEST_KEY", None)
        else:
            os.environ["MAKA_TEST_KEY"] = self._prev_key
        self._tmp.cleanup()

    def _write_artifacts(
        self, guest_payload: object = None, transcript_bytes: bytes | None = b"{}\n"
    ) -> None:
        maka_dir = self.logs_dir / "maka"
        maka_dir.mkdir(parents=True, exist_ok=True)
        if guest_payload is not None:
            raw = (
                guest_payload
                if isinstance(guest_payload, str)
                else json.dumps(guest_payload)
            )
            (maka_dir / "guest-result.json").write_text(raw, encoding="utf-8")
        if transcript_bytes is not None:
            (maka_dir / "transcript.json").write_bytes(transcript_bytes)

    def _run_async(self, coro):
        return asyncio.run(coro)

    def test_setup_wraps_non_infra_exceptions_and_passes_through_cancelled(self) -> None:
        agent = _make_agent(self.logs_dir)

        for exc in (
            subprocess.CalledProcessError(1, ["docker"]),
            ValueError("bad value"),
            MakaInfraError("direct infra"),
        ):
            env = _FakeEnvironment()
            env.exec_handler = lambda _cmd, exc=exc, **_kw: exc
            with self.assertRaises(MakaInfraError) as ctx:
                self._run_async(agent.setup(env))
            if isinstance(exc, MakaInfraError):
                self.assertEqual(str(ctx.exception), "direct infra")

        env_cancel = _FakeEnvironment()
        env_cancel.exec_handler = lambda _cmd, **_kw: asyncio.CancelledError()
        with self.assertRaises(asyncio.CancelledError):
            self._run_async(agent.setup(env_cancel))

    def test_run_wraps_unexpected_exceptions_and_cleans_up_uploaded_request(self) -> None:
        agent = _make_agent(self.logs_dir)

        # Upload failure still triggers root rm -f cleanup with timeout_sec=5.
        env_upload = _FakeEnvironment()
        env_upload.upload_error = subprocess.CalledProcessError(1, ["docker", "cp"])
        with self.assertRaises(MakaInfraError):
            self._run_async(agent.run("task", env_upload, _StubAgentContext()))
        rm_calls = [c for c in env_upload.exec_calls if "rm -f " in str(c["command"])]
        self.assertEqual(len(rm_calls), 1)
        self.assertEqual(rm_calls[0]["user"], "root")
        self.assertEqual(rm_calls[0]["timeout_sec"], 5)

        # Non-OSError/RuntimeError exceptions from download_file or context coercion wrap to MakaInfraError.
        env_download = _FakeEnvironment(mounted=False)
        env_download.download_handler = lambda _src, _dst: (_ for _ in ()).throw(
            ValueError("download exploded")
        )
        with self.assertRaises(MakaInfraError):
            self._run_async(agent.run("task", env_download, _StubAgentContext()))

        # Mounted exit-0 run with non-numeric token value raises MakaInfraError and skips rm -f.
        env_bad_val = _FakeEnvironment(mounted=True)
        self._write_artifacts(
            {"completed": {"settlement": _valid_settlement(input_tokens="not-an-int")}}  # type: ignore[arg-type]
        )
        with self.assertRaises(MakaInfraError):
            self._run_async(agent.run("task", env_bad_val, _StubAgentContext()))
        self.assertEqual(
            [c for c in env_bad_val.exec_calls if "rm -f " in str(c["command"])],
            [],
        )

    def test_run_cancelled_passes_through_after_request_cleanup(self) -> None:
        agent = _make_agent(self.logs_dir)
        env = _FakeEnvironment()

        def _exec_handler(command: str, **_kw):
            if command == "id -u && id -g":
                return _ExecResult(0, "1000\n1000\n", "")
            if "guest-run" in command:
                return asyncio.CancelledError()
            return _ExecResult(0, "", "")

        env.exec_handler = _exec_handler
        with self.assertRaises(asyncio.CancelledError):
            self._run_async(agent.run("task", env, _StubAgentContext()))
        rm_calls = [c for c in env.exec_calls if "rm -f " in str(c["command"])]
        self.assertEqual(len(rm_calls), 1)
        self.assertEqual(rm_calls[0]["user"], "root")
        self.assertEqual(rm_calls[0]["timeout_sec"], 5)

    def test_run_clears_request_uploaded_after_zero_exit_and_validates_artifacts(self) -> None:
        agent = _make_agent(self.logs_dir)

        bad_payloads: list[tuple[object, bytes | None]] = [
            ("[]", b"{}\n"),
            ({}, b"{}\n"),
            ({"infraFailed": {"infraError": "boom"}}, b"{}\n"),
            ({"completed": {}}, b"{}\n"),
            ({"completed": {"settlement": {"metering": "unknown_mode"}}}, b"{}\n"),
            (
                {"completed": {"settlement": _valid_settlement()}},
                b"",
            ),
            (
                {"completed": {"settlement": _valid_settlement()}},
                None,
            ),
        ]

        for payload, transcript in bad_payloads:
            maka_dir = self.logs_dir / "maka"
            if maka_dir.exists():
                for item in maka_dir.iterdir():
                    item.unlink()
            self._write_artifacts(payload, transcript)
            env = _FakeEnvironment(mounted=True)
            with self.assertRaises(MakaInfraError, msg=f"payload={payload!r}"):
                self._run_async(agent.run("task", env, _StubAgentContext()))
            rm_calls = [c for c in env.exec_calls if "rm -f " in str(c["command"])]
            self.assertEqual(rm_calls, [])

    def test_run_populates_context_for_mounted_and_unmounted_artifacts(self) -> None:
        # Mounted complete + priced.
        agent = _make_agent(self.logs_dir)
        env_mounted = _FakeEnvironment(mounted=True)
        self._write_artifacts(
            {
                "completed": {
                    "settlement": _valid_settlement(
                        input_tokens=120,
                        cache_tokens=40,
                        output_tokens=25,
                        metering={"complete": {"costUsd": 0.00125}},
                    )
                }
            }
        )
        ctx1 = _StubAgentContext()
        self._run_async(agent.run("task", env_mounted, ctx1))
        self.assertTrue(env_mounted.prepared_logs)
        self.assertEqual(ctx1.n_input_tokens, 120)
        self.assertEqual(ctx1.n_cache_tokens, 40)
        self.assertEqual(ctx1.n_output_tokens, 25)
        self.assertAlmostEqual(ctx1.cost_usd or 0.0, 0.00125)

        # Unmounted unpriced complete ({complete: {}}).
        env_unpriced = _FakeEnvironment(mounted=False)

        def _dl_unpriced(src: str, dst: Path) -> None:
            if src.endswith("guest-result.json"):
                dst.write_text(
                    json.dumps(
                        {
                            "completed": {
                                "settlement": _valid_settlement(
                                    input_tokens=50,
                                    cache_tokens=0,
                                    output_tokens=10,
                                    metering={"complete": {}},
                                )
                            }
                        }
                    ),
                    encoding="utf-8",
                )
            elif src.endswith("transcript.json"):
                dst.write_text("{\"pages\": []}\n", encoding="utf-8")

        env_unpriced.download_handler = _dl_unpriced
        ctx2 = _StubAgentContext()
        self._run_async(agent.run("task", env_unpriced, ctx2))
        self.assertEqual(len(env_unpriced.downloaded_files), 2)
        self.assertEqual(ctx2.n_input_tokens, 50)
        self.assertEqual(ctx2.n_cache_tokens, 0)
        self.assertEqual(ctx2.n_output_tokens, 10)
        self.assertIsNone(ctx2.cost_usd)

        # Mounted subjectStopped + lower_bound (tokens omitted).
        env_stopped = _FakeEnvironment(mounted=True)
        self._write_artifacts(
            {
                "subjectStopped": {
                    "stopReason": "exceeded maxSteps (1)",
                    "settlement": {"metering": "lower_bound"},
                }
            }
        )
        ctx3 = _StubAgentContext()
        self._run_async(agent.run("task", env_stopped, ctx3))
        self.assertIsNone(ctx3.n_input_tokens)
        self.assertIsNone(ctx3.n_cache_tokens)
        self.assertIsNone(ctx3.n_output_tokens)
        self.assertIsNone(ctx3.cost_usd)

    def test_run_deducts_setup_elapsed_and_fails_when_budget_exhausted(self) -> None:
        # Patch only the adapter module's `time` binding so asyncio's own loop clock stays real.
        agent_ok = _make_agent(self.logs_dir, timeout_ms=5000)
        env_ok = _FakeEnvironment(mounted=True)
        self._write_artifacts({"completed": {"settlement": _valid_settlement()}})
        calls_ok = iter([100.0, 101.2])
        fake_time_ok = types.SimpleNamespace(monotonic=lambda: next(calls_ok))
        with mock.patch.object(_MOD, "time", fake_time_ok):
            self._run_async(agent_ok.run("task", env_ok, _StubAgentContext()))
        guest_cmds = [
            str(c["command"]) for c in env_ok.exec_calls if "guest-run" in str(c["command"])
        ]
        self.assertEqual(len(guest_cmds), 1)
        self.assertIn("--timeout-ms 3800", guest_cmds[0])

        # Setup exhausts budget -> raises MakaInfraError, never invokes guest-run, cleans request.
        agent_expired = _make_agent(self.logs_dir, timeout_ms=1000)
        env_expired = _FakeEnvironment(mounted=True)
        calls_exp = iter([200.0, 201.0])
        fake_time_exp = types.SimpleNamespace(monotonic=lambda: next(calls_exp))
        with mock.patch.object(_MOD, "time", fake_time_exp):
            with self.assertRaises(MakaInfraError) as ctx:
                self._run_async(agent_expired.run("task", env_expired, _StubAgentContext()))
        self.assertIn("exhausted before guest-run started", str(ctx.exception))
        self.assertEqual(
            [c for c in env_expired.exec_calls if "guest-run" in str(c["command"])],
            [],
        )
        rm_calls = [c for c in env_expired.exec_calls if "rm -f " in str(c["command"])]
        self.assertEqual(len(rm_calls), 1)
        self.assertEqual(rm_calls[0]["user"], "root")
        self.assertEqual(rm_calls[0]["timeout_sec"], 5)


if __name__ == "__main__":
    unittest.main()
