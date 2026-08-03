"""Harbor adapter for the pinned official Codex CLI."""

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

# harness_compat picks the harbor.* tree under plain Harbor 0.13.2 and the
# pier.* tree under Pier, whose parallel classes are type-incompatible with
# harbor's (Pier's TrialResult only accepts Pier's AgentInfo).
from harness_compat import (
    AgentContext,
    BaseEnvironment,
    Codex,
)
from harness_compat import (
    NetworkAllowlist as _NetworkAllowlist,
)
from process_scope import cleanup_process_scope, scoped_command
from provider_proxy import provider_proxy_endpoint, warn_if_pier_unreachable_proxy_port
from trial_pricing import estimate_cost, pricing_from_env

_TOOLCHAIN_ROOT = Path("/opt/maka-codex-toolchain")
_TOOLCHAIN_BIN = _TOOLCHAIN_ROOT / "bin"
_TOOLCHAIN_CODEX = _TOOLCHAIN_BIN / "codex"
_TOOLCHAIN_NODE = _TOOLCHAIN_BIN / "node"
_TOOLCHAIN_MANIFEST = _TOOLCHAIN_ROOT / "manifest.json"
_TOOLCHAIN_CHECKSUMS = _TOOLCHAIN_ROOT / "checksums.sha256"
_DEFAULT_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
_OUTPUT_FILENAME = "codex.txt"
_REMOTE_OUTPUT_PATH = Path("/logs/agent") / _OUTPUT_FILENAME
_REMOTE_SESSIONS_DIR = Path("/logs/agent/sessions")
# Flash entry from DeepSeek's official codex-deepseek-setup.sh. Keeping the
# catalog in the read-only repo mount preserves the provider's native Codex
# instructions and model capabilities without downloading configuration in a
# benchmark task.
_DEEPSEEK_MODELS_PATH = Path(
    "/opt/maka-agent/packages/headless/harbor/deepseek-codex-models.json"
)


class MakaCodexAgent(Codex):
    """Run a fixed Codex CLI build behind Maka's host provider proxy."""

    def get_version_command(self) -> str | None:
        return f"{shlex.quote(str(_TOOLCHAIN_CODEX))} --version"

    def install_spec(self) -> None:
        # The pinned Codex toolchain is bind-mounted read-only and only
        # verified (sha256 checksums + manifest fingerprint) in install().
        # Pier's inherited spec would instead install Codex from the network
        # (npm/nvm), which offline tasks (allow_internet=false) cannot reach
        # and which would break the fixed-build comparison. None keeps the
        # runtime verify path unchanged (Pier runs install() when no spec is
        # preinstalled).
        return None

    def network_allowlist(self) -> _NetworkAllowlist | None:
        # Called only under Pier; plain Harbor never calls it and
        # harness_compat exports NetworkAllowlist = None there.
        if _NetworkAllowlist is None:
            return None
        # The inherited allowlist collects OPENAI_BASE_URL (masked to None by
        # this adapter's _get_env) and falls back to api.openai.com — neither
        # is what this adapter dials. The container runs the pinned Codex CLI
        # against the maka-http provider config, which points at
        # MAKA_PROVIDER_PROXY_URL; that proxy host is the only egress the
        # container needs. A missing or malformed proxy URL fails here, at
        # environment creation — no fallback domain, so a misconfigured trial
        # never gets a spurious egress grant.
        hostname, port = provider_proxy_endpoint(self._get_env, "Codex")
        warn_if_pier_unreachable_proxy_port(port, "Codex")
        return _NetworkAllowlist(domains=[hostname])

    async def install(self, environment: BaseEnvironment) -> None:
        expected_fingerprint = self._get_env("MAKA_CODEX_TOOLCHAIN_FINGERPRINT")
        if not expected_fingerprint:
            raise ValueError("MAKA_CODEX_TOOLCHAIN_FINGERPRINT is required")
        manifest_check = (
            "const fs = require('node:fs'); "
            "const manifest = JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); "
            "if (manifest.fingerprint !== process.env.MAKA_EXPECTED_TOOLCHAIN_FINGERPRINT) "
            "throw new Error('Codex toolchain fingerprint mismatch');"
        )
        command = (
            "set -euo pipefail; "
            'test "$(uname -s)" = Linux; '
            'test "$(uname -m)" = x86_64; '
            f"cd {shlex.quote(str(_TOOLCHAIN_ROOT))}; "
            f"sha256sum --check {shlex.quote(_TOOLCHAIN_CHECKSUMS.name)}; "
            f"{shlex.quote(str(_TOOLCHAIN_NODE))} -e {shlex.quote(manifest_check)} "
            f"{shlex.quote(str(_TOOLCHAIN_MANIFEST))}; "
            f"test -x {shlex.quote(str(_TOOLCHAIN_CODEX))}"
        )
        await self.exec_as_agent(
            environment,
            command=command,
            env={"MAKA_EXPECTED_TOOLCHAIN_FINGERPRINT": expected_fingerprint},
        )
        await self.exec_as_root(
            environment,
            command=f"ln -sf -- {shlex.quote(str(_TOOLCHAIN_CODEX))} /usr/local/bin/codex",
        )

    def _get_env(self, key: str) -> str | None:
        if key == "OPENAI_API_KEY":
            return super()._get_env("MAKA_PROVIDER_PROXY_TOKEN")
        if key == "OPENAI_BASE_URL":
            return None
        if key in {"CODEX_AUTH_JSON_PATH", "CODEX_FORCE_AUTH_JSON"}:
            return None
        return super()._get_env(key)

    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        proxy_url = self._get_env("MAKA_PROVIDER_PROXY_URL")
        proxy_token = self._get_env("OPENAI_API_KEY")
        if not proxy_url or not proxy_token:
            raise ValueError("Codex requires the host provider proxy")
        self._started_at_ms = int(time.time() * 1000)
        self._write_execution_identity()
        output_path = self.logs_dir / _OUTPUT_FILENAME
        if output_path.exists():
            output_path.unlink()
        self._extra_env["PATH"] = f"{_TOOLCHAIN_BIN}:{_DEFAULT_PATH}"
        command_scope = secrets.token_urlsafe(24)
        self._active_command_scope = command_scope
        abnormal_exit = False
        try:
            await self._write_http_provider_config(environment, proxy_url)
            await super().run(instruction, environment, context)
        except asyncio.CancelledError:
            abnormal_exit = True
            self._deadline_settled = True
            self._failure_class = "budget_exhausted"
            raise
        except BaseException as error:
            abnormal_exit = True
            self._failure_class = (
                _classify_failure(error, self._events())
                if isinstance(error, Exception)
                else "infra_failed"
            )
            raise
        finally:
            self._active_command_scope = None
            try:
                if abnormal_exit:
                    await cleanup_process_scope(self, environment, command_scope)
            finally:
                self._finished_at_ms = int(time.time() * 1000)
                await self._download_agent_logs(environment)

    async def _download_agent_logs(self, environment: BaseEnvironment) -> None:
        # populate_context_post_run and _write_cell_output read codex.txt and
        # sessions/**/rollout-*.jsonl from the host log dir. Under Harbor the
        # agent log dir is bind-mounted, so both are already host-side and are
        # skipped; under Pier a --mounts-json run replaces the default log
        # mounts while capabilities.mounted stays true (pier docker.py), so
        # pier's own log download never runs — without this hydration
        # _events() sees nothing and a real token-burning run is misclassified
        # as failed. Runs in run()'s finally so failure paths are hydrated too.
        local_output = self.logs_dir / _OUTPUT_FILENAME
        if not local_output.exists():
            try:
                await environment.download_file(_REMOTE_OUTPUT_PATH.as_posix(), local_output)
            except Exception as exc:  # noqa: BLE001 - best-effort log hydration.
                self.logger.debug(
                    "Could not download Codex output %s: %s", _REMOTE_OUTPUT_PATH, exc
                )
        local_sessions = self.logs_dir / "sessions"
        if not local_sessions.exists():
            try:
                # docker cp of `dir/.` requires an existing target directory.
                local_sessions.mkdir(parents=True, exist_ok=True)
                await environment.download_dir(
                    source_dir=_REMOTE_SESSIONS_DIR.as_posix(),
                    target_dir=local_sessions,
                )
            except Exception as exc:  # noqa: BLE001 - best-effort log hydration.
                self.logger.debug(
                    "Could not download Codex sessions %s: %s", _REMOTE_SESSIONS_DIR, exc
                )

    async def _write_http_provider_config(
        self, environment: BaseEnvironment, proxy_url: str
    ) -> None:
        codex_home = self._REMOTE_CODEX_HOME.as_posix()
        config_path = (self._REMOTE_CODEX_HOME / "config.toml").as_posix()
        model = self._get_env("MAKA_MODEL") or self.model_name
        deepseek_catalog = model == "deepseek-v4-flash"
        config = "\n".join(
            (
                'model_provider = "maka-http"',
                *(
                    (f'model_catalog_json = "{_DEEPSEEK_MODELS_PATH.as_posix()}"',)
                    if deepseek_catalog
                    else ()
                ),
                "",
                "[model_providers.maka-http]",
                'name = "Maka HTTP"',
                f"base_url = {json.dumps(proxy_url)}",
                'wire_api = "responses"',
                "requires_openai_auth = true",
                "supports_websockets = false",
                "",
            )
        )
        await self.exec_as_agent(
            environment,
            command=(
                f"mkdir -p {shlex.quote(codex_home)}; "
                f"printf '%s\\n' {shlex.quote(config)} > {shlex.quote(config_path)}"
            ),
        )

    async def exec_as_agent(
        self,
        environment: BaseEnvironment,
        command: str,
        **kwargs: Any,
    ) -> Any:
        command_scope = getattr(self, "_active_command_scope", None)
        if command_scope:
            command = scoped_command(
                command,
                command_scope,
                secrets.token_urlsafe(12),
            )
        return await super().exec_as_agent(environment, command=command, **kwargs)

    def populate_context_post_run(self, context: AgentContext) -> None:
        super().populate_context_post_run(context)
        self._apply_cost_metadata(context)
        self._write_cell_output(context)

    def _apply_cost_metadata(self, context: AgentContext) -> None:
        totals = self._token_totals(context)
        if totals is None:
            context.metadata = {
                **(getattr(context, "metadata", None) or {}),
                "codex_pricing_source": "missing_usage",
            }
            return
        reported_cost = getattr(context, "cost_usd", None)
        estimated_cost = reported_cost
        pricing_source = "codex" if estimated_cost is not None else None
        pricing = pricing_from_env(self._get_env)
        if pricing is not None:
            estimated_cost = estimate_cost(totals, pricing)
            context.cost_usd = estimated_cost
            pricing_source = self._get_env("MAKA_TRIAL_PRICING_SOURCE") or "env"
        context.metadata = {
            **(getattr(context, "metadata", None) or {}),
            "codex_input_tokens": totals["input"],
            "codex_output_tokens": totals["output"],
            "codex_cached_input_tokens": totals["cache_read"],
            "codex_cache_miss_input_tokens": totals["cache_miss"],
            "codex_estimated_cost_usd": estimated_cost,
            "codex_reported_cost_usd": reported_cost,
            "codex_pricing_source": pricing_source or "missing_pricing",
        }

    def _token_totals(self, context: AgentContext) -> dict[str, int] | None:
        raw_input = getattr(context, "n_input_tokens", None)
        raw_output = getattr(context, "n_output_tokens", None)
        raw_cache_read = getattr(context, "n_cache_tokens", None)
        if raw_input is None and raw_output is None and raw_cache_read is None:
            return self._rollout_token_totals()
        input_tokens = int(raw_input or 0)
        output_tokens = int(raw_output or 0)
        cache_read = int(raw_cache_read or 0)
        return {
            "input": input_tokens,
            "output": output_tokens,
            "cache_read": cache_read,
            "cache_write": 0,
            "cache_miss": max(0, input_tokens - cache_read),
            "reasoning": self._reasoning_tokens(),
        }

    def _rollout_token_totals(self) -> dict[str, int] | None:
        latest: tuple[str, dict[str, Any]] | None = None
        for path in sorted(self.logs_dir.glob("sessions/**/rollout-*.jsonl")):
            for line in path.read_text(encoding="utf-8").splitlines():
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if not isinstance(event, dict) or event.get("type") != "event_msg":
                    continue
                payload = event.get("payload")
                if not isinstance(payload, dict) or payload.get("type") != "token_count":
                    continue
                info = payload.get("info")
                usage = info.get("total_token_usage") if isinstance(info, dict) else None
                if not isinstance(usage, dict):
                    continue
                timestamp = event.get("timestamp")
                if not isinstance(timestamp, str):
                    timestamp = ""
                if latest is None or timestamp >= latest[0]:
                    latest = (timestamp, usage)
        if latest is None:
            return None
        usage = latest[1]

        def count(key: str) -> int:
            value = usage.get(key)
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                return max(0, int(value))
            return 0

        input_tokens = count("input_tokens")
        cache_read = count("cached_input_tokens")
        output_tokens = count("output_tokens")
        return {
            "input": input_tokens,
            "output": output_tokens,
            "cache_read": cache_read,
            "cache_write": 0,
            "cache_miss": max(0, input_tokens - cache_read),
            "reasoning": count("reasoning_output_tokens"),
        }

    def _events(self) -> list[dict[str, Any]]:
        path = self.logs_dir / _OUTPUT_FILENAME
        if not path.exists():
            return []
        events: list[dict[str, Any]] = []
        for line in path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(event, dict):
                events.append(event)
        return events

    def _reasoning_tokens(self) -> int:
        for event in reversed(self._events()):
            if event.get("type") != "turn.completed":
                continue
            usage = event.get("usage")
            if isinstance(usage, dict):
                value = usage.get("reasoning_output_tokens")
                if isinstance(value, (int, float)) and not isinstance(value, bool):
                    return int(value)
        return 0

    def _write_cell_output(self, context: AgentContext) -> None:
        events = self._events()
        completed = any(event.get("type") == "turn.completed" for event in events)
        failed = hasattr(self, "_failure_class") or not completed
        error_class = getattr(self, "_failure_class", None)
        if failed and error_class is None:
            error_class = _classify_failure(
                RuntimeError("Codex exited without a turn.completed event"), events
            )
        totals = self._token_totals(context)
        started_at = getattr(self, "_started_at_ms", int(time.time() * 1000))
        finished_at = getattr(self, "_finished_at_ms", started_at)
        identity = self._execution_identity()
        tool_call_counts: dict[str, int] = {}
        session_id = "codex"
        for event in events:
            if event.get("type") == "thread.started" and event.get("thread_id"):
                session_id = str(event["thread_id"])
            if event.get("type") != "item.completed":
                continue
            item = event.get("item")
            if not isinstance(item, dict):
                continue
            item_type = item.get("type")
            if item_type not in {
                "command_execution",
                "file_change",
                "mcp_tool_call",
                "web_search",
            }:
                continue
            name = str(item_type)
            tool_call_counts[name] = tool_call_counts.get(name, 0) + 1
        token_summary = None
        cost = getattr(context, "cost_usd", None)
        if totals is not None and cost is not None:
            token_summary = {
                "input": totals["input"],
                "cachedInput": totals["cache_read"],
                "cacheHitInput": totals["cache_read"],
                "cacheMissInput": totals["cache_miss"],
                "cacheWriteInput": totals["cache_write"],
                "cacheMissInputSource": "explicit",
                "output": totals["output"],
                "reasoning": totals["reasoning"],
                "total": totals["input"] + totals["output"],
                "costUsd": float(cost),
                "pricingSource": "runtime",
            }
        self.logs_dir.mkdir(parents=True, exist_ok=True)
        source_path = self.logs_dir / _OUTPUT_FILENAME
        (self.logs_dir / "runtime-events.jsonl").write_text(
            source_path.read_text(encoding="utf-8") if source_path.exists() else "",
            encoding="utf-8",
        )
        output = {
            "schemaVersion": 1,
            "status": "failed" if failed else "completed",
            **({"errorClass": error_class} if error_class else {}),
            **(
                {
                    "deadlineSettlement": {
                        "source": "benchmark.deadline",
                        "mode": "immediate",
                    }
                }
                if getattr(self, "_deadline_settled", False)
                else {}
            ),
            "runtimeEventsPath": "/logs/agent/runtime-events.jsonl",
            "promptHash": identity["systemPromptHash"],
            "executionIdentity": identity,
            **({"tokenSummary": token_summary} if token_summary is not None else {}),
            "toolSummary": {
                "providerVisibleToolCount": 0,
                "actualToolCalls": sum(tool_call_counts.values()),
                "actualToolNames": sorted(tool_call_counts),
                "actualToolCallCounts": tool_call_counts,
            },
            "steps": sum(1 for event in events if event.get("type") == "turn.completed"),
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
            json.dumps(
                system_prompt, ensure_ascii=False, separators=(",", ":")
            ).encode("utf-8")
        ).hexdigest()
        effort = self._get_env("MAKA_REASONING_EFFORT")
        return {
            "llmConnectionSlug": self._get_env("MAKA_LLM_CONNECTION_SLUG")
            or "openai",
            "model": self._get_env("MAKA_MODEL") or self.model_name or "unknown",
            **({"reasoningEffort": effort} if effort else {}),
            "systemPromptHash": prompt_hash,
            "pricingProfile": self._get_env("MAKA_TRIAL_PRICING_SOURCE")
            or "unconfigured",
            "agentTools": False,
        }

    def _write_execution_identity(self) -> None:
        self.logs_dir.mkdir(parents=True, exist_ok=True)
        path = self.logs_dir / "maka-cell-execution-identity.json"
        with path.open("w", encoding="utf-8") as output:
            output.write(json.dumps(self._execution_identity(), indent=2) + "\n")
            output.flush()
            os.fsync(output.fileno())


def _structured_failure_text(events: list[dict[str, Any]]) -> str | None:
    for event in reversed(events):
        if event.get("type") == "turn.failed":
            error = event.get("error")
            if isinstance(error, dict) and isinstance(error.get("message"), str):
                return error["message"]
            if isinstance(error, str):
                return error
        if event.get("type") == "error" and isinstance(event.get("message"), str):
            return event["message"]
    return None


def _classify_failure(
    error: Exception, events: list[dict[str, Any]] | None = None
) -> str:
    text = (_structured_failure_text(events or []) or str(error)).lower()
    if any(
        marker in text
        for marker in (
            "flagged for possible cybersecurity risk",
            "trusted access for cyber",
        )
    ):
        return "policy_denied"
    if re.search(r"(?<!\d)(401|403)(?!\d)", text) or any(
        marker in text
        for marker in ("unauthorized", "authentication", "invalid api key")
    ):
        return "auth"
    if re.search(r"(?<!\d)429(?!\d)", text) or any(
        marker in text for marker in ("rate limit", "too many requests")
    ):
        return "rate_limit"
    if any(marker in text for marker in ("billing", "insufficient credit", "quota exceeded")):
        return "provider_billing"
    if any(
        marker in text
        for marker in (
            "connection",
            "network",
            "dns",
            "socket",
            "certificate",
            "unknownissuer",
            "stream disconnected",
            "error sending request",
        )
    ):
        return "network"
    if re.search(r"(?<!\d)(500|502|503|504)(?!\d)", text) or "unavailable" in text:
        return "provider_unavailable"
    return "infra_failed"
