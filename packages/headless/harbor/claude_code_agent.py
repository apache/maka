"""Harbor adapter for the pinned official Claude Code native binary."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import secrets
import shlex
import time
from pathlib import Path
from typing import Any

from harness_compat import (
    AgentContext,
    BaseEnvironment,
    ClaudeCode,
)
from harness_compat import (
    NetworkAllowlist as _NetworkAllowlist,
)
from process_scope import cleanup_process_scope, scoped_command
from provider_proxy import provider_proxy_endpoint, warn_if_pier_unreachable_proxy_port

_TOOLCHAIN_ROOT = Path("/opt/maka-claude-code-toolchain")
_TOOLCHAIN_CLAUDE = _TOOLCHAIN_ROOT / "bin" / "claude"
_TOOLCHAIN_MANIFEST = _TOOLCHAIN_ROOT / "manifest.json"
_TOOLCHAIN_CHECKSUMS = _TOOLCHAIN_ROOT / "checksums.sha256"
_OUTPUT_FILENAME = "claude-code.txt"
_REMOTE_OUTPUT_PATH = Path("/logs/agent") / _OUTPUT_FILENAME
_REMOTE_SESSIONS_DIR = Path("/logs/agent/sessions")


class MakaClaudeCodeAgent(ClaudeCode):
    """Run a fixed Claude Code build behind Maka's host provider proxy."""

    def get_version_command(self) -> str | None:
        return f"{shlex.quote(str(_TOOLCHAIN_CLAUDE))} --version"

    def install_spec(self) -> None:
        return None

    def network_allowlist(self) -> _NetworkAllowlist | None:
        if _NetworkAllowlist is None:
            return None
        hostname, port = provider_proxy_endpoint(self._get_env, "Claude Code")
        warn_if_pier_unreachable_proxy_port(port, "Claude Code")
        return _NetworkAllowlist(domains=[hostname])

    async def install(self, environment: BaseEnvironment) -> None:
        expected_fingerprint = self._get_env("MAKA_CLAUDE_CODE_TOOLCHAIN_FINGERPRINT")
        if not expected_fingerprint:
            raise ValueError("MAKA_CLAUDE_CODE_TOOLCHAIN_FINGERPRINT is required")
        command = (
            "set -euo pipefail; "
            'test "$(uname -s)" = Linux; '
            'test "$(uname -m)" = x86_64; '
            f"cd {shlex.quote(str(_TOOLCHAIN_ROOT))}; "
            f"sha256sum --check {shlex.quote(_TOOLCHAIN_CHECKSUMS.name)}; "
            f"grep -Fq -- \"\\\"fingerprint\\\": \\\"$MAKA_EXPECTED_TOOLCHAIN_FINGERPRINT\\\"\" "
            f"{shlex.quote(str(_TOOLCHAIN_MANIFEST))}; "
            f"test -x {shlex.quote(str(_TOOLCHAIN_CLAUDE))}"
        )
        await self.exec_as_agent(
            environment,
            command=command,
            env={"MAKA_EXPECTED_TOOLCHAIN_FINGERPRINT": expected_fingerprint},
        )
        await self.exec_as_root(
            environment,
            command=f"ln -sf -- {shlex.quote(str(_TOOLCHAIN_CLAUDE))} /usr/local/bin/claude",
        )

    def _get_env(self, key: str) -> str | None:
        if key == "ANTHROPIC_API_KEY":
            return super()._get_env("MAKA_PROVIDER_PROXY_TOKEN")
        if key in {"ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_FORCE_OAUTH"}:
            return None
        return super()._get_env(key)

    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        proxy_url = self._get_env("MAKA_PROVIDER_PROXY_URL")
        if not proxy_url or not self._get_env("ANTHROPIC_API_KEY"):
            raise ValueError("Claude Code requires the host provider proxy")
        self._started_at_ms = int(time.time() * 1000)
        self._write_execution_identity()
        output_path = self.logs_dir / _OUTPUT_FILENAME
        if output_path.exists():
            output_path.unlink()
        command_scope = secrets.token_urlsafe(24)
        self._active_command_scope = command_scope
        previous_base_url = os.environ.get("ANTHROPIC_BASE_URL")
        os.environ["ANTHROPIC_BASE_URL"] = proxy_url
        abnormal_exit = False
        try:
            await super().run(instruction, environment, context)
        except asyncio.CancelledError:
            abnormal_exit = True
            self._failure_class = "budget_exhausted"
            raise
        except BaseException as error:
            abnormal_exit = True
            self._failure_class = (
                _classify_failure(error) if isinstance(error, Exception) else "infra_failed"
            )
            raise
        finally:
            if previous_base_url is None:
                os.environ.pop("ANTHROPIC_BASE_URL", None)
            else:
                os.environ["ANTHROPIC_BASE_URL"] = previous_base_url
            self._active_command_scope = None
            try:
                if abnormal_exit:
                    await cleanup_process_scope(self, environment, command_scope)
            finally:
                self._finished_at_ms = int(time.time() * 1000)
                await self._download_agent_logs(environment)

    async def _download_agent_logs(self, environment: BaseEnvironment) -> None:
        local_output = self.logs_dir / _OUTPUT_FILENAME
        if not local_output.exists():
            try:
                await environment.download_file(_REMOTE_OUTPUT_PATH.as_posix(), local_output)
            except Exception as exc:  # noqa: BLE001 - best-effort log hydration.
                self.logger.debug("Could not download Claude Code output %s: %s", _REMOTE_OUTPUT_PATH, exc)
        local_sessions = self.logs_dir / "sessions"
        if not local_sessions.exists():
            try:
                local_sessions.mkdir(parents=True, exist_ok=True)
                await environment.download_dir(
                    source_dir=_REMOTE_SESSIONS_DIR.as_posix(),
                    target_dir=local_sessions,
                )
            except Exception as exc:  # noqa: BLE001 - best-effort log hydration.
                self.logger.debug("Could not download Claude Code sessions %s: %s", _REMOTE_SESSIONS_DIR, exc)

    async def exec_as_agent(
        self,
        environment: BaseEnvironment,
        command: str,
        **kwargs: Any,
    ) -> Any:
        command_scope = getattr(self, "_active_command_scope", None)
        if command_scope:
            command = f"set -o pipefail; {command}"
            command = scoped_command(command, command_scope, secrets.token_urlsafe(12))
        return await super().exec_as_agent(environment, command=command, **kwargs)

    def populate_context_post_run(self, context: AgentContext) -> None:
        super().populate_context_post_run(context)
        self._write_cell_output()

    def _events(self) -> list[dict[str, Any]]:
        path = self.logs_dir / _OUTPUT_FILENAME
        if not path.exists():
            return []
        events: list[dict[str, Any]] = []
        for line in path.read_text(encoding="utf-8").splitlines():
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(event, dict):
                events.append(event)
        return events

    def _write_cell_output(self) -> None:
        started_at = getattr(self, "_started_at_ms", int(time.time() * 1000))
        finished_at = getattr(self, "_finished_at_ms", started_at)
        identity = self._execution_identity()
        events = self._events()
        terminal_result = next(
            (event for event in reversed(events) if event.get("type") == "result"),
            None,
        )
        error_class = getattr(self, "_failure_class", None)
        if error_class is None and (
            terminal_result is None or terminal_result.get("is_error") is not False
        ):
            failure_details = (
                " ".join(
                    str(terminal_result[key])
                    for key in ("subtype", "error", "message", "result")
                    if terminal_result.get(key) is not None
                )
                if terminal_result is not None
                else "Claude Code exited without a result event"
            )
            error_class = _classify_failure(
                RuntimeError(failure_details)
            )
        tool_call_counts: dict[str, int] = {}
        session_id = "claude-code"
        assistant_steps = 0
        for event in events:
            session_id = str(event.get("session_id") or event.get("sessionId") or session_id)
            if event.get("type") == "assistant":
                assistant_steps += 1
            message = event.get("message")
            content = message.get("content") if isinstance(message, dict) else None
            if not isinstance(content, list):
                continue
            for block in content:
                if not isinstance(block, dict) or block.get("type") != "tool_use":
                    continue
                name = str(block.get("name") or "unknown")
                tool_call_counts[name] = tool_call_counts.get(name, 0) + 1
        self.logs_dir.mkdir(parents=True, exist_ok=True)
        source_path = self.logs_dir / _OUTPUT_FILENAME
        (self.logs_dir / "runtime-events.jsonl").write_text(
            source_path.read_text(encoding="utf-8") if source_path.exists() else "",
            encoding="utf-8",
        )
        output = {
            "schemaVersion": 1,
            "status": "failed" if error_class is not None else "completed",
            **({"errorClass": error_class} if error_class is not None else {}),
            "runtimeEventsPath": "/logs/agent/runtime-events.jsonl",
            "promptHash": identity["systemPromptHash"],
            "executionIdentity": identity,
            "toolSummary": {
                "providerVisibleToolCount": 0,
                "actualToolCalls": sum(tool_call_counts.values()),
                "actualToolNames": sorted(tool_call_counts),
                "actualToolCallCounts": tool_call_counts,
            },
            "steps": assistant_steps,
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
            "llmConnectionSlug": self._get_env("MAKA_LLM_CONNECTION_SLUG") or "deepseek",
            "model": self._get_env("MAKA_MODEL") or self.model_name or "deepseek-v4-flash",
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
    if _has_http_status(text, 401, 403) or any(
        marker in text for marker in ("unauthorized", "authentication", "invalid api key")
    ):
        return "auth"
    if _has_http_status(text, 429) or any(marker in text for marker in ("rate limit", "too many requests")):
        return "rate_limit"
    if any(marker in text for marker in ("billing", "insufficient credit", "quota exceeded")):
        return "provider_billing"
    if any(marker in text for marker in ("connection", "network", "dns", "socket")):
        return "network"
    if _has_http_status(text, 500, 502, 503, 504) or "unavailable" in text:
        return "provider_unavailable"
    return "infra_failed"


def _has_http_status(text: str, *codes: int) -> bool:
    alternatives = "|".join(str(code) for code in codes)
    return re.search(
        rf"\b(?:http(?: error)?|status(?: code)?|code)\s*[:=]?\s*(?:{alternatives})\b",
        text,
    ) is not None
