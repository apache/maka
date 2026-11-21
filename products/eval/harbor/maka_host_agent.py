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

import json
import math
import os
import shlex
import tempfile
import time
from pathlib import Path

from harbor.agents.base import BaseAgent
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext


class MakaInfraError(RuntimeError):
    """Non-retriable infrastructure/metering failure recorded without grading."""


def _require_non_bool_int(value: object, field: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise ValueError(f"{field} must be a non-negative integer")
    return value


def _parse_evidenced_result(
    payload: object,
) -> tuple[dict[str, int | None], float | None]:
    if not isinstance(payload, dict):
        raise ValueError("guest-result.json must be a JSON object")
    status = payload.get("status")
    if status == "completed":
        pass
    elif status == "subjectStopped":
        if not isinstance(payload.get("stopReason"), str):
            raise ValueError("subjectStopped result requires string stopReason")
    else:
        raise ValueError(f"non-evidenced guest result status: {status!r}")

    evidence = payload.get("evidence")
    settlement = payload.get("settlement")
    if not isinstance(evidence, dict) or not isinstance(settlement, dict):
        raise ValueError("guest-result.json missing evidence or settlement object")

    execution = evidence.get("execution")
    if not isinstance(execution, dict):
        raise ValueError("evidence.execution must be an object")
    state = execution.get("state")
    if not isinstance(state, dict) or state.get("kind") not in (
        "completed",
        "failed",
        "cancelled",
    ):
        raise ValueError(f"non-terminal or invalid execution.state: {state!r}")

    summary = evidence["hostUsage"]["summary"]
    if not isinstance(summary, dict):
        raise ValueError("evidence.hostUsage.summary must be an object")
    pending_models = _require_non_bool_int(
        summary["pending"]["models"], "pending.models"
    )
    models = summary["models"]
    if not isinstance(models, dict):
        raise ValueError("summary.models must be an object")

    tokens: dict[str, int | None] = {
        "n_input_tokens": None,
        "n_cache_tokens": None,
        "n_output_tokens": None,
    }
    for usage_key, ctx_key in (
        ("input", "n_input_tokens"),
        ("cacheRead", "n_cache_tokens"),
        ("output", "n_output_tokens"),
    ):
        bucket = models[usage_key]
        if not isinstance(bucket, dict):
            raise ValueError(f"summary.models.{usage_key} must be an object")
        known = _require_non_bool_int(bucket["known"], f"{usage_key}.known")
        missing = _require_non_bool_int(bucket["missing"], f"{usage_key}.missing")
        if pending_models == 0 and missing == 0:
            tokens[ctx_key] = known

    settlement_status = settlement.get("status")
    if settlement_status not in ("complete", "lower_bound"):
        raise ValueError(f"invalid settlement.status: {settlement_status!r}")
    cost_usd: float | None = None
    raw_cost = settlement.get("costUsd")
    if settlement_status == "complete" and raw_cost is not None:
        if (
            isinstance(raw_cost, bool)
            or not isinstance(raw_cost, (int, float))
            or not math.isfinite(float(raw_cost))
        ):
            raise ValueError(f"invalid settlement.costUsd: {raw_cost!r}")
        cost_usd = float(raw_cost)

    return tokens, cost_usd


class MakaHostAgent(BaseAgent):
    """Harbor adapter that drives native maka host via `/opt/maka-agent/maka-eval guest-run`."""

    def __init__(self, logs_dir: Path, model_name: str | None = None, **kwargs):
        self._endpoint_url: str | None = kwargs.pop("endpoint_url", None) or None
        self._api_key_env: str = kwargs.pop("api_key_env")
        self._provider: str = kwargs.pop("provider")
        self._model_id: str = kwargs.pop("model_id", None) or model_name or ""
        self._thinking_level: str | None = kwargs.pop("thinking_level", None) or None
        self._sandbox_mode: str = kwargs.pop("sandbox_mode")
        raw_max_steps = kwargs.pop("max_steps", None)
        self._max_steps: int | None = int(raw_max_steps) if raw_max_steps is not None else None
        raw_timeout_ms = kwargs.pop("timeout_ms", None)
        self._timeout_ms: int | None = int(raw_timeout_ms) if raw_timeout_ms is not None else None
        if not self._model_id:
            raise ValueError("MakaHostAgent requires model_id or model_name")
        super().__init__(logs_dir, model_name=model_name, **kwargs)

    @staticmethod
    def name() -> str:
        return "maka-host"

    def version(self) -> str:
        return "0.2.0"

    async def _resolve_uid_gid(self, environment: BaseEnvironment) -> tuple[str, str]:
        uid_res = await environment.exec("id -u && id -g")
        if uid_res.return_code != 0 or not uid_res.stdout:
            raise MakaInfraError(f"failed to resolve container uid/gid: {uid_res.stderr}")
        parts = [line.strip() for line in uid_res.stdout.strip().splitlines() if line.strip()]
        if len(parts) < 2 or not parts[0].isdigit() or not parts[1].isdigit():
            raise MakaInfraError(f"unexpected uid/gid output: {uid_res.stdout!r}")
        return parts[0], parts[1]

    async def setup(self, environment: BaseEnvironment) -> None:
        check = await environment.exec(
            "test -x /opt/maka-agent/maka "
            "&& test -x /opt/maka-agent/maka-python-worker "
            "&& test -x /opt/maka-agent/maka-eval"
        )
        if check.return_code != 0:
            raise MakaInfraError(
                "missing executable binaries under /opt/maka-agent: "
                f"{check.stderr or check.stdout}"
            )

        uid, gid = await self._resolve_uid_gid(environment)
        prep_home = await environment.exec(
            f'pw_dir="$(awk -F: -v u={uid} \'$3==u{{print $6; exit}}\' /etc/passwd)"; '
            f'if [ -z "$pw_dir" ]; then '
            f'  pw_dir="/tmp/maka-home-{uid}"; '
            f'  mkdir -p "$pw_dir" && chown {uid}:{gid} "$pw_dir"; '
            f'  printf "maka-eval-%s:x:%s:%s::%s:/bin/sh\\n" "{uid}" "{uid}" "{gid}" "$pw_dir" >> /etc/passwd; '
            f'elif [ "$pw_dir" = "/" ]; then '
            f'  mkdir -p /.local/share/Maka /.cache/maka '
            f'  && chown -R {uid}:{gid} /.local/share/Maka /.cache/maka; '
            f'else '
            f'  mkdir -p "$pw_dir" && chown {uid}:{gid} "$pw_dir"; '
            f'fi',
            user="root",
        )
        if prep_home.return_code != 0:
            raise MakaInfraError(f"failed preparing container home dir: {prep_home.stderr}")

    async def _cleanup_request(
        self, environment: BaseEnvironment, request_remote: str, q_req: str
    ) -> None:
        try:
            res = await environment.exec(f"rm -f {q_req}", user="root")
            if res.return_code != 0:
                self.logger.warning(
                    "failed removing temporary guest request %s (rc=%s): %s",
                    request_remote,
                    res.return_code,
                    res.stderr or res.stdout,
                )
        except Exception as exc:
            self.logger.warning(
                "failed removing temporary guest request %s: %s",
                request_remote,
                exc,
            )

    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        del context
        run_started = time.monotonic()
        api_key = os.environ.get(self._api_key_env, "")
        if not api_key:
            raise MakaInfraError(
                f"environment variable '{self._api_key_env}' is unset or empty"
            )

        uid, gid = await self._resolve_uid_gid(environment)
        pwd_res = await environment.exec("pwd")
        workspace_dir = (pwd_res.stdout or "").strip() or "/app"

        maka_logs = self.logs_dir / "maka"
        maka_logs.mkdir(parents=True, exist_ok=True)
        maka_logs.chmod(0o777)

        remote_maka_logs = f"{self.environment_logs_dir.as_posix()}/maka"
        request_remote = f"/tmp/maka-eval-request-{os.getpid()}.json"
        result_remote = f"{remote_maka_logs}/guest-result.json"

        request_payload = {
            "instruction": instruction,
            "workspaceDir": workspace_dir,
            "artifactsDir": remote_maka_logs,
            "baseUrl": self._endpoint_url,
            "apiKey": api_key,
            "provider": self._provider,
            "modelId": self._model_id,
            "thinkingLevel": self._thinking_level,
            "sandboxMode": self._sandbox_mode,
            "maxSteps": self._max_steps,
        }

        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as tmp:
            os.chmod(tmp.name, 0o600)
            json.dump(request_payload, tmp)
            tmp_path = Path(tmp.name)

        q_req = shlex.quote(request_remote)
        q_logs = shlex.quote(remote_maka_logs)
        try:
            try:
                await environment.upload_file(tmp_path, request_remote)
            finally:
                tmp_path.unlink(missing_ok=True)

            prep_req = await environment.exec(
                f"chown {uid}:{gid} {q_req} && chmod 600 {q_req} "
                f"&& mkdir -p {q_logs} && chmod 777 {q_logs}",
                user="root",
            )
            if prep_req.return_code != 0:
                raise MakaInfraError(
                    f"failed preparing guest request/log permissions: "
                    f"{prep_req.stderr or prep_req.stdout}"
                )

            cmd = (
                f"/opt/maka-agent/maka-eval guest-run "
                f"--request-file {q_req} "
                f"--result-file {shlex.quote(result_remote)}"
            )
            if self._timeout_ms is not None:
                elapsed_ms = round((time.monotonic() - run_started) * 1000)
                remaining_ms = self._timeout_ms - elapsed_ms
                if remaining_ms <= 0:
                    raise MakaInfraError(
                        f"agent timeout budget ({self._timeout_ms} ms) exhausted before guest-run "
                        f"started ({elapsed_ms} ms elapsed during setup)"
                    )
                cmd += f" --timeout-ms {remaining_ms}"

            exec_res = await environment.exec(
                cmd,
                env={
                    "NO_PROXY": "localhost,127.0.0.1,::1,host.docker.internal",
                    "no_proxy": "localhost,127.0.0.1,::1,host.docker.internal",
                },
            )
            if exec_res.stdout:
                (maka_logs / "guest-run.stdout.log").write_text(exec_res.stdout)
            if exec_res.stderr:
                (maka_logs / "guest-run.stderr.log").write_text(exec_res.stderr)

            if exec_res.return_code != 0:
                raise MakaInfraError(
                    f"maka-eval guest-run exited with {exec_res.return_code}: "
                    f"{exec_res.stderr or exec_res.stdout}"
                )

            transcript_remote = f"{remote_maka_logs}/transcript.json"
            guest_path = maka_logs / "guest-result.json"
            mounted = environment.is_path_mounted(self.environment_logs_dir, self.logs_dir)
            try:
                if mounted:
                    await environment.prepare_logs_for_host()
                    transcript_ok = (maka_logs / "transcript.json").is_file()
                else:
                    await environment.download_file(result_remote, guest_path)
                    transcript_check = await environment.exec(
                        f"test -f {shlex.quote(transcript_remote)}",
                        user="root",
                    )
                    transcript_ok = transcript_check.return_code == 0
                payload = json.loads(guest_path.read_text(encoding="utf-8"))
                if isinstance(payload, dict) and payload.get("status") == "infraFailed":
                    raise ValueError(
                        f"guest-result.json recorded infraFailed: {payload.get('infraError')!r}"
                    )
                _parse_evidenced_result(payload)
            except (OSError, RuntimeError, KeyError, TypeError, ValueError) as exc:
                raise MakaInfraError(
                    f"invalid guest-result.json at {guest_path}: {exc}"
                ) from exc

            if not transcript_ok:
                raise MakaInfraError(
                    f"missing exported transcript.json at {maka_logs / 'transcript.json'}"
                )
        except BaseException:
            await self._cleanup_request(environment, request_remote, q_req)
            raise

    def populate_context_post_run(self, context: AgentContext) -> None:
        guest_path = self.logs_dir / "maka" / "guest-result.json"
        try:
            payload = json.loads(guest_path.read_text(encoding="utf-8"))
            if isinstance(payload, dict) and payload.get("status") == "infraFailed":
                return
            tokens, cost_usd = _parse_evidenced_result(payload)
        except FileNotFoundError:
            return
        except (OSError, KeyError, TypeError, ValueError) as exc:
            self.logger.warning(
                "failed populating AgentContext from %s: %s", guest_path, exc
            )
            return

        # Host input already includes cached tokens, matching Harbor's AgentContext contract.
        if tokens["n_input_tokens"] is not None:
            context.n_input_tokens = tokens["n_input_tokens"]
        if tokens["n_cache_tokens"] is not None:
            context.n_cache_tokens = tokens["n_cache_tokens"]
        if tokens["n_output_tokens"] is not None:
            context.n_output_tokens = tokens["n_output_tokens"]
        if cost_usd is not None:
            context.cost_usd = cost_usd
