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
from pathlib import Path

from harbor.agents.base import BaseAgent
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext


class MakaHostAgent(BaseAgent):
    """Harbor adapter that drives native maka host via `/opt/maka-agent/maka-eval guest-run`."""

    def __init__(self, logs_dir: Path, model_name: str | None = None, **kwargs):
        self._endpoint_url: str | None = kwargs.pop("endpoint_url", None) or None
        self._api_key_env: str = kwargs.pop("api_key_env")
        self._provider: str = kwargs.pop("provider")
        self._connection_slug: str = kwargs.pop("connection_slug")
        self._model_id: str = kwargs.pop("model_id", None) or model_name or ""
        self._sandbox_mode: str = kwargs.pop("sandbox_mode")
        self._max_steps: int = int(kwargs.pop("max_steps"))
        self._timeout_ms: int = int(kwargs.pop("timeout_ms"))
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
            raise RuntimeError(f"failed to resolve container uid/gid: {uid_res.stderr}")
        parts = [line.strip() for line in uid_res.stdout.strip().splitlines() if line.strip()]
        if len(parts) < 2 or not parts[0].isdigit() or not parts[1].isdigit():
            raise RuntimeError(f"unexpected uid/gid output: {uid_res.stdout!r}")
        return parts[0], parts[1]

    async def setup(self, environment: BaseEnvironment) -> None:
        check = await environment.exec(
            "test -x /opt/maka-agent/maka "
            "&& test -x /opt/maka-agent/maka-python-worker "
            "&& test -x /opt/maka-agent/maka-eval"
        )
        if check.return_code != 0:
            raise RuntimeError(
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
            raise RuntimeError(f"failed preparing container home dir: {prep_home.stderr}")

    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        del context
        api_key = os.environ.get(self._api_key_env, "")
        if not api_key:
            raise RuntimeError(
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
            "connectionSlug": self._connection_slug,
            "modelId": self._model_id,
            "sandboxMode": self._sandbox_mode,
            "maxSteps": self._max_steps,
            "timeoutMs": self._timeout_ms,
        }

        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as tmp:
            os.chmod(tmp.name, 0o600)
            json.dump(request_payload, tmp)
            tmp_path = Path(tmp.name)

        q_req = shlex.quote(request_remote)
        q_logs = shlex.quote(remote_maka_logs)
        try:
            await environment.upload_file(tmp_path, request_remote)
            prep_req = await environment.exec(
                f"chown {uid}:{gid} {q_req} && chmod 600 {q_req} "
                f"&& mkdir -p {q_logs} && chmod 777 {q_logs}",
                user="root",
            )
            if prep_req.return_code != 0:
                await environment.exec(f"rm -f {q_req}", user="root")
                raise RuntimeError(
                    f"failed preparing guest request/log permissions: "
                    f"{prep_req.stderr or prep_req.stdout}"
                )
        finally:
            tmp_path.unlink(missing_ok=True)

        exec_res = await environment.exec(
            f"/opt/maka-agent/maka-eval guest-run "
            f"--request-file {q_req} "
            f"--result-file {shlex.quote(result_remote)}",
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
            try:
                await environment.exec(f"rm -f {q_req}", user="root")
            except Exception:
                pass
            raise RuntimeError(
                f"maka-eval guest-run exited with {exec_res.return_code}: "
                f"{exec_res.stderr or exec_res.stdout}"
            )
