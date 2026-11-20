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


def _populate_agent_context(context: AgentContext, payload: object) -> None:
    """Populate Harbor's AgentContext from a validated guest-result payload."""
    if not isinstance(payload, dict):
        return
    body = payload.get("completed") or payload.get("subjectStopped")
    if not isinstance(body, dict):
        return
    settlement = body.get("settlement")
    if not isinstance(settlement, dict):
        return
    for src_key, ctx_key in (
        ("inputTokens", "n_input_tokens"),
        ("cacheTokens", "n_cache_tokens"),
        ("outputTokens", "n_output_tokens"),
    ):
        val = settlement.get(src_key)
        if val is not None:
            setattr(context, ctx_key, int(val))
    metering = settlement.get("metering")
    if isinstance(metering, dict):
        complete = metering.get("complete")
        if isinstance(complete, dict) and complete.get("costUsd") is not None:
            context.cost_usd = float(complete["costUsd"])


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
        return "0.3.0"

    async def _resolve_uid_gid(self, environment: BaseEnvironment) -> tuple[str, str]:
        uid_res = await environment.exec("id -u && id -g")
        if uid_res.return_code != 0 or not uid_res.stdout:
            raise MakaInfraError(f"failed to resolve container uid/gid: {uid_res.stderr}")
        parts = [line.strip() for line in uid_res.stdout.strip().splitlines() if line.strip()]
        if len(parts) < 2 or not parts[0].isdigit() or not parts[1].isdigit():
            raise MakaInfraError(f"unexpected uid/gid output: {uid_res.stdout!r}")
        return parts[0], parts[1]

    async def setup(self, environment: BaseEnvironment) -> None:
        try:
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
                raise MakaInfraError(
                    f"failed preparing container home dir: {prep_home.stderr}"
                )
        except MakaInfraError:
            raise
        except (OSError, RuntimeError) as exc:
            raise MakaInfraError(f"maka agent setup failed: {exc}") from exc

    async def _cleanup_request(
        self, environment: BaseEnvironment, request_remote: str, q_req: str
    ) -> None:
        try:
            res = await environment.exec(
                f"rm -f {q_req}", user="root", timeout_sec=5
            )
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
        run_started = time.monotonic()
        api_key = os.environ.get(self._api_key_env, "")
        if not api_key:
            raise MakaInfraError(
                f"environment variable '{self._api_key_env}' is unset or empty"
            )

        request_remote = f"/tmp/maka-eval-request-{os.getpid()}.json"
        q_req = shlex.quote(request_remote)
        request_uploaded = False
        try:
            uid, gid = await self._resolve_uid_gid(environment)

            maka_logs = self.logs_dir / "maka"
            maka_logs.mkdir(parents=True, exist_ok=True)
            maka_logs.chmod(0o777)

            remote_maka_logs = f"{self.environment_logs_dir.as_posix()}/maka"
            result_remote = f"{remote_maka_logs}/guest-result.json"

            request_payload = {
                "instruction": instruction,
                "artifactsDir": remote_maka_logs,
                "baseUrl": self._endpoint_url,
                "apiKey": api_key,
                "provider": self._provider,
                "modelId": self._model_id,
                "thinkingLevel": self._thinking_level,
                "sandboxMode": self._sandbox_mode,
                "maxSteps": self._max_steps,
            }

            tmp_path: Path | None = None
            try:
                with tempfile.NamedTemporaryFile(
                    "w", suffix=".json", delete=False
                ) as tmp:
                    tmp_path = Path(tmp.name)
                    os.chmod(tmp_path, 0o600)
                    json.dump(request_payload, tmp)
                request_uploaded = True
                await environment.upload_file(tmp_path, request_remote)
            finally:
                if tmp_path is not None:
                    tmp_path.unlink(missing_ok=True)

            q_logs = shlex.quote(remote_maka_logs)
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

            if environment.is_path_mounted(self.environment_logs_dir, self.logs_dir):
                await environment.prepare_logs_for_host()
            else:
                for artifact_name in ("guest-result.json", "transcript.json"):
                    await environment.download_file(
                        f"{remote_maka_logs}/{artifact_name}",
                        maka_logs / artifact_name,
                    )

            guest_result_path = maka_logs / "guest-result.json"
            try:
                payload = json.loads(guest_result_path.read_text(encoding="utf-8"))
            except (OSError, ValueError) as exc:
                raise MakaInfraError(
                    f"required guest artifact unreadable or invalid JSON ({guest_result_path}): {exc}"
                ) from exc

            transcript_path = maka_logs / "transcript.json"
            try:
                with transcript_path.open("rb") as fh:
                    if not fh.read(1):
                        raise MakaInfraError(
                            f"required guest artifact is empty: {transcript_path}"
                        )
            except OSError as exc:
                raise MakaInfraError(
                    f"required guest artifact unreadable ({transcript_path}): {exc}"
                ) from exc

            _populate_agent_context(context, payload)
        except BaseException as exc:
            if request_uploaded:
                await self._cleanup_request(environment, request_remote, q_req)
            if isinstance(exc, MakaInfraError):
                raise
            if isinstance(exc, (OSError, RuntimeError)):
                raise MakaInfraError(f"maka agent execution failed: {exc}") from exc
            raise
