"""Harbor adapter for the pinned official Kimi Code CLI."""

from __future__ import annotations

import hashlib
import json
import os
import re
import secrets
import shlex
import time
from pathlib import Path
from typing import Any

# harness_compat picks the harbor.* tree under plain Harbor 0.13.2 and the
# pier.* tree under Pier, whose parallel classes are type-incompatible with
# harbor's (Pier's TrialResult only accepts Pier's AgentInfo).
from harness_compat import (
    AgentContext,
    BaseEnvironment,
    BaseInstalledAgent,
    NetworkAllowlist as _NetworkAllowlist,
    with_prompt_template,
)
from process_scope import cleanup_process_scope, scoped_command
from provider_proxy import provider_proxy_endpoint, warn_if_pier_unreachable_proxy_port

_TOOLCHAIN_ROOT = Path("/opt/maka-kimi-code-toolchain")
_TOOLCHAIN_NODE = _TOOLCHAIN_ROOT / "bin" / "node"
_TOOLCHAIN_ENTRYPOINT = _TOOLCHAIN_ROOT / "lib" / "kimi-code" / "main.mjs"
_TOOLCHAIN_MANIFEST = _TOOLCHAIN_ROOT / "manifest.json"
_TOOLCHAIN_CHECKSUMS = _TOOLCHAIN_ROOT / "checksums.sha256"
_OUTPUT_PATH = Path("/logs/agent/kimi-code.jsonl")
_KIMI_HOME = Path("/tmp/maka-kimi-code")
_PRINT_CONFIG = """[background]
print_background_mode = "exit"
keep_alive_on_exit = true
"""
_REQUEST_TIMEOUT_GRACE_SEC = 120
_DEFAULT_CELL_TIMEOUT_SEC = 900
_MAX_SAFE_INTEGER = 9007199254740991
_POSITIVE_INT_RE = re.compile(r"[1-9][0-9]*")


class MakaKimiCodeAgent(BaseInstalledAgent):
    """Run Kimi Code in deterministic print mode for a single Harbor task."""

    @staticmethod
    def name() -> str:
        return "kimi-code"

    def install_spec(self) -> None:
        # The Kimi Code toolchain is baked into the task image and only verified
        # (sha256 checksums + manifest fingerprint) in install(); there is
        # nothing to install at Pier build time. Pier declares this abstract on
        # BaseInstalledAgent; None keeps the runtime verify path unchanged.
        return None

    def network_allowlist(self) -> _NetworkAllowlist | None:
        # Called only under Pier; plain Harbor never calls it and harness_compat
        # exports NetworkAllowlist = None there.
        if _NetworkAllowlist is None:
            return None
        # The container runs the pre-baked Kimi Code CLI against
        # KIMI_MODEL_BASE_URL, which _runtime_env() sets to
        # MAKA_PROVIDER_PROXY_URL. The toolchain is verified offline (no install
        # download), so the only outbound host the container needs is that model
        # endpoint. A missing or malformed proxy URL fails here, at environment
        # creation — no fallback domain, so a misconfigured trial never gets a
        # spurious egress grant.
        hostname, port = provider_proxy_endpoint(self._get_env, "Kimi Code")
        warn_if_pier_unreachable_proxy_port(port, "Kimi Code")
        return _NetworkAllowlist(domains=[hostname])

    def get_version_command(self) -> str | None:
        return (
            f"{shlex.quote(str(_TOOLCHAIN_NODE))} "
            f"{shlex.quote(str(_TOOLCHAIN_ENTRYPOINT))} --version"
        )

    async def install(self, environment: BaseEnvironment) -> None:
        expected_fingerprint = self._get_env("MAKA_KIMI_CODE_TOOLCHAIN_FINGERPRINT")
        if not expected_fingerprint:
            raise ValueError("MAKA_KIMI_CODE_TOOLCHAIN_FINGERPRINT is required")
        manifest_check = (
            "const fs = require('node:fs'); "
            "const manifest = JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); "
            "if (manifest.fingerprint !== process.env.MAKA_EXPECTED_TOOLCHAIN_FINGERPRINT) "
            "throw new Error('Kimi Code toolchain fingerprint mismatch');"
        )
        command = (
            "set -euo pipefail; "
            'test "$(uname -s)" = Linux; '
            'test "$(uname -m)" = x86_64; '
            f"cd {shlex.quote(str(_TOOLCHAIN_ROOT))}; "
            f"sha256sum --check {shlex.quote(_TOOLCHAIN_CHECKSUMS.name)}; "
            f"{shlex.quote(str(_TOOLCHAIN_NODE))} -e {shlex.quote(manifest_check)} "
            f"{shlex.quote(str(_TOOLCHAIN_MANIFEST))}"
        )
        await self.exec_as_agent(
            environment,
            command=command,
            env={"MAKA_EXPECTED_TOOLCHAIN_FINGERPRINT": expected_fingerprint},
        )

    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        self._started_at_ms = int(time.time() * 1000)
        self._write_execution_identity()
        command_scope = secrets.token_urlsafe(24)
        abnormal_exit = False
        try:
            command = (
                f"mkdir -p {shlex.quote(str(_KIMI_HOME))}; "
                f"printf %s {shlex.quote(_PRINT_CONFIG)} > "
                f"{shlex.quote(str(_KIMI_HOME / 'config.toml'))}; "
                f"{shlex.quote(str(_TOOLCHAIN_NODE))} "
                f"{shlex.quote(str(_TOOLCHAIN_ENTRYPOINT))} "
                "--output-format stream-json --prompt "
                f"{shlex.quote(instruction)} "
                f"> {shlex.quote(str(_OUTPUT_PATH))} "
                "2> /logs/agent/kimi-code.stderr.txt"
            )
            await self.exec_as_agent(
                environment,
                command=scoped_command(
                    command,
                    command_scope,
                    secrets.token_urlsafe(12),
                ),
                env=self._runtime_env(),
            )
        except BaseException as error:
            abnormal_exit = True
            if isinstance(error, Exception):
                self._failure_class = _classify_failure(error)
            raise
        finally:
            try:
                if abnormal_exit:
                    await cleanup_process_scope(self, environment, command_scope)
            finally:
                self._finished_at_ms = int(time.time() * 1000)
                await self._download_agent_logs(environment)

    async def _download_agent_logs(self, environment: BaseEnvironment) -> None:
        # _write_cell_output's only in-container input is the stream-json the
        # CLI writes to /logs/agent/kimi-code.jsonl (identity and timestamps
        # are host-side). Under Harbor the agent log dir is bind-mounted, so
        # the file is already host-side and is skipped; under Pier a
        # --mounts-json run replaces the default log mounts while
        # capabilities.mounted stays true (pier docker.py), so pier's own log
        # download never runs — without this download, _events() sees nothing
        # and a real token-burning run is misclassified as infra. Runs in
        # run()'s finally so the AgentTimeoutError path is hydrated too.
        local = self.logs_dir / _OUTPUT_PATH.name
        if local.exists():
            return
        try:
            await environment.download_file(_OUTPUT_PATH.as_posix(), local)
        except Exception as exc:  # noqa: BLE001 - best-effort log hydration.
            self.logger.debug("Could not download Kimi Code stream %s: %s", _OUTPUT_PATH, exc)

    def populate_context_post_run(self, context: AgentContext) -> None:
        self._write_cell_output()

    def _runtime_env(self) -> dict[str, str]:
        # The proxy URL is forwarded opaquely (IPv6 included) — endpoint-shape
        # validation is a Pier allowlist constraint and lives in
        # network_allowlist(), not in this plain-Harbor code path.
        proxy_url = self._get_env("MAKA_PROVIDER_PROXY_URL")
        proxy_token = self._get_env("MAKA_PROVIDER_PROXY_TOKEN")
        if not proxy_url or not proxy_token:
            raise ValueError("Kimi Code requires the host provider proxy")
        model = self._get_env("MAKA_MODEL") or self.model_name
        if not model:
            raise ValueError("MAKA_MODEL is required")
        effort = self._get_env("MAKA_REASONING_EFFORT") or "max"
        task_timeout_sec = self._cell_timeout_sec()
        return {
            "KIMI_CODE_HOME": str(_KIMI_HOME),
            "KIMI_MODEL_NAME": model,
            "KIMI_MODEL_API_KEY": proxy_token,
            "KIMI_MODEL_PROVIDER_TYPE": "kimi",
            "KIMI_MODEL_BASE_URL": proxy_url,
            "KIMI_MODEL_MAX_CONTEXT_SIZE": "1048576",
            "KIMI_MODEL_MAX_OUTPUT_SIZE": "131072",
            "KIMI_MODEL_MAX_COMPLETION_TOKENS": "131072",
            "KIMI_MODEL_REQUEST_TIMEOUT_MS": str(
                (task_timeout_sec + _REQUEST_TIMEOUT_GRACE_SEC) * 1000
            ),
            "KIMI_MODEL_ADAPTIVE_THINKING": "true",
            "KIMI_MODEL_THINKING_EFFORT": effort,
        }

    def _cell_timeout_sec(self) -> int:
        raw = self._get_env("MAKA_CELL_TIMEOUT_SEC")
        if not raw:
            return _DEFAULT_CELL_TIMEOUT_SEC
        stripped = raw.strip()
        if _POSITIVE_INT_RE.fullmatch(stripped) is None:
            return _DEFAULT_CELL_TIMEOUT_SEC
        try:
            value = int(stripped)
        except ValueError:
            return _DEFAULT_CELL_TIMEOUT_SEC
        return value if value <= _MAX_SAFE_INTEGER else _DEFAULT_CELL_TIMEOUT_SEC

    def _events(self, *, require_assistant: bool = False) -> list[dict[str, Any]]:
        path = self.logs_dir / _OUTPUT_PATH.name
        if not path.exists():
            if require_assistant:
                raise ValueError("Kimi Code stream-json did not contain an assistant message")
            return []
        events = []
        for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
            if not line.strip():
                continue
            try:
                value = json.loads(line)
            except json.JSONDecodeError as error:
                if require_assistant:
                    raise ValueError(f"Kimi Code stream-json line {line_number} is not valid JSON") from error
                continue
            if not isinstance(value, dict):
                if require_assistant:
                    raise ValueError(f"Kimi Code stream-json line {line_number} must be a JSON object")
                continue
            events.append(value)
        if require_assistant and not any(event.get("role") == "assistant" for event in events):
            raise ValueError("Kimi Code stream-json did not contain an assistant message")
        return events

    def _write_cell_output(self) -> None:
        started_at = getattr(self, "_started_at_ms", int(time.time() * 1000))
        finished_at = getattr(self, "_finished_at_ms", started_at)
        identity = self._execution_identity()
        events = self._events(require_assistant=not hasattr(self, "_failure_class"))
        tool_call_counts: dict[str, int] = {}
        session_id = "kimi-code"
        for event in events:
            if event.get("type") == "session.resume_hint" and event.get("session_id"):
                session_id = str(event["session_id"])
            tool_calls = event.get("tool_calls")
            if not isinstance(tool_calls, list):
                continue
            for tool_call in tool_calls:
                function = tool_call.get("function") if isinstance(tool_call, dict) else None
                name = function.get("name") if isinstance(function, dict) else None
                if name:
                    key = str(name)
                    tool_call_counts[key] = tool_call_counts.get(key, 0) + 1
        self.logs_dir.mkdir(parents=True, exist_ok=True)
        runtime_events_path = self.logs_dir / "runtime-events.jsonl"
        source_path = self.logs_dir / _OUTPUT_PATH.name
        runtime_events_path.write_text(
            source_path.read_text(encoding="utf-8") if source_path.exists() else "",
            encoding="utf-8",
        )
        output = {
            "schemaVersion": 1,
            "status": "failed" if hasattr(self, "_failure_class") else "completed",
            **({"errorClass": self._failure_class} if hasattr(self, "_failure_class") else {}),
            "runtimeEventsPath": "/logs/agent/runtime-events.jsonl",
            "promptHash": identity["systemPromptHash"],
            "executionIdentity": identity,
            "toolSummary": {
                "providerVisibleToolCount": 0,
                "actualToolCalls": sum(tool_call_counts.values()),
                "actualToolNames": sorted(tool_call_counts),
                "actualToolCallCounts": tool_call_counts,
            },
            "steps": sum(1 for event in events if event.get("role") == "assistant"),
            "durationMs": max(0, finished_at - started_at),
            "startedAt": started_at,
            "finishedAt": finished_at,
            "runtimeRefs": {
                "invocationId": session_id,
                "sessionId": session_id,
                "runId": session_id,
                "turnId": session_id,
            },
        }
        (self.logs_dir / "maka-cell-output.json").write_text(
            json.dumps(output, indent=2) + "\n", encoding="utf-8"
        )

    def _execution_identity(self) -> dict[str, Any]:
        system_prompt = self._get_env("MAKA_SYSTEM_PROMPT") or ""
        prompt_hash = "sha256:" + hashlib.sha256(
            json.dumps(system_prompt, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        ).hexdigest()
        effort = self._get_env("MAKA_REASONING_EFFORT")
        return {
            "llmConnectionSlug": self._get_env("MAKA_LLM_CONNECTION_SLUG") or "kimi-coding-plan",
            "model": self._get_env("MAKA_MODEL") or self.model_name or "k3",
            **({"reasoningEffort": effort} if effort else {}),
            "systemPromptHash": prompt_hash,
            "pricingProfile": self._get_env("MAKA_TRIAL_PRICING_SOURCE") or "unconfigured",
            "agentTools": False,
        }

    def _write_execution_identity(self) -> None:
        self.logs_dir.mkdir(parents=True, exist_ok=True)
        path = self.logs_dir / "maka-cell-execution-identity.json"
        with path.open("w", encoding="utf-8") as output:
            output.write(json.dumps(self._execution_identity(), indent=2) + "\n")
            output.flush()
            os.fsync(output.fileno())


def _classify_failure(error: Exception) -> str:
    text = str(error).lower()
    if any(marker in text for marker in ("401", "403", "unauthorized", "authentication", "invalid api key")):
        return "auth"
    if any(marker in text for marker in ("429", "rate limit", "too many requests")):
        return "rate_limit"
    if any(marker in text for marker in ("billing", "insufficient credit", "quota exceeded")):
        return "provider_billing"
    if any(marker in text for marker in ("connection", "network", "dns", "socket")):
        return "network"
    if any(marker in text for marker in ("500", "502", "503", "504", "unavailable")):
        return "provider_unavailable"
    return "infra_failed"
