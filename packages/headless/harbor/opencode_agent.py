"""Harbor OpenCode adapter wrapper with Maka benchmark cost metadata."""

from __future__ import annotations

import hashlib
import json
import os
import shlex
import time
from pathlib import Path
from typing import Any

from harness_compat import (
    AgentContext,
    BaseEnvironment,
    NetworkAllowlist as _NetworkAllowlist,
    NonZeroAgentExitCodeError,
    OpenCode,
    with_prompt_template,
)
from provider_proxy import provider_proxy_endpoint, warn_if_pier_unreachable_proxy_port

from trial_pricing import estimate_cost, pricing_from_env

_TOOLCHAIN_ROOT = Path("/opt/maka-opencode-toolchain")
_TOOLCHAIN_NODE = _TOOLCHAIN_ROOT / "bin" / "node"
_TOOLCHAIN_OPENCODE = _TOOLCHAIN_ROOT / "bin" / "opencode"
_TOOLCHAIN_MANIFEST = _TOOLCHAIN_ROOT / "manifest.json"
_TOOLCHAIN_CHECKSUMS = _TOOLCHAIN_ROOT / "checksums.sha256"


class MakaOpenCodeAgent(OpenCode):
    """Run Harbor's OpenCode agent while normalizing trial cost fields."""

    @staticmethod
    def name() -> str:
        return "opencode"

    def get_version_command(self) -> str | None:
        return f"{shlex.quote(str(_TOOLCHAIN_OPENCODE))} --version"

    def install_spec(self) -> None:
        # The pinned OpenCode toolchain is bind-mounted read-only and only
        # verified (sha256 checksums + manifest fingerprint) in install().
        # Pier's inherited spec would instead install OpenCode from the
        # network, which offline tasks cannot reach and which would break the
        # fixed-build comparison. None keeps the runtime verify path
        # unchanged (Pier runs install() when no spec is preinstalled).
        return None

    def network_allowlist(self) -> _NetworkAllowlist | None:
        # Called only under Pier; plain Harbor never calls it and
        # harness_compat exports NetworkAllowlist = None there.
        if _NetworkAllowlist is None:
            return None
        # The container runs the pinned OpenCode CLI against
        # OPENCODE_CONFIG (opencode-benchmark.json), whose provider options
        # point at MAKA_PROVIDER_PROXY_URL (see _run_with_stop_sentinel);
        # that proxy host is the only egress the container needs. No fallback
        # domain: a misconfigured trial fails here, at environment creation.
        hostname, port = provider_proxy_endpoint(self._get_env, "OpenCode")
        warn_if_pier_unreachable_proxy_port(port, "OpenCode")
        return _NetworkAllowlist(domains=[hostname])

    async def install(self, environment: BaseEnvironment) -> None:
        expected_fingerprint = self._get_env("MAKA_OPENCODE_TOOLCHAIN_FINGERPRINT")
        if not expected_fingerprint:
            raise ValueError("MAKA_OPENCODE_TOOLCHAIN_FINGERPRINT is required")
        manifest_check = (
            "const fs = require('node:fs'); "
            "const manifest = JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); "
            "if (manifest.fingerprint !== process.env.MAKA_EXPECTED_TOOLCHAIN_FINGERPRINT) "
            "throw new Error('OpenCode toolchain fingerprint mismatch');"
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
        try:
            await self._run_with_stop_sentinel(instruction, environment)
            # Hydrate before reading error events: under Pier the explicit
            # --mounts-json replaces the default /logs bind-mount, so the CLI
            # stream only exists inside the container until downloaded.
            await self._download_agent_logs(environment)
            if messages := self._error_messages():
                raise NonZeroAgentExitCodeError(
                    "OpenCode emitted error event(s): " + "; ".join(messages[:3])
                )
        except Exception as error:
            self._failure_class = self._classify_failure(error)
            raise
        finally:
            self._finished_at_ms = int(time.time() * 1000)
            await self._download_agent_logs(environment)

    async def _download_agent_logs(self, environment: BaseEnvironment) -> None:
        # _error_messages() and populate_context_post_run read opencode.txt
        # from the host log dir. Under plain Harbor the agent log dir is
        # bind-mounted, so the file is already host-side and is skipped; under
        # Pier a --mounts-json run replaces the default log mounts while
        # capabilities.mounted stays true (pier docker.py), so pier's own log
        # download never runs — without this hydration a real provider error
        # event is invisible to failure classification and the parsed
        # trajectory/steps/token metadata come out empty. Best-effort, same
        # contract as the Kimi and Codex arms.
        local = self.logs_dir / "opencode.txt"
        if local.exists():
            return
        try:
            await environment.download_file("/logs/agent/opencode.txt", local)
        except Exception as exc:  # noqa: BLE001 - best-effort log hydration.
            self.logger.debug("Could not download OpenCode stream %s: %s", local, exc)

    def populate_context_post_run(self, context: AgentContext) -> None:
        super().populate_context_post_run(context)
        self._apply_cost_metadata(context)
        self._write_cell_output(context)

    def _apply_cost_metadata(self, context: AgentContext) -> None:
        totals = self._token_totals(context)
        if totals is None:
            context.metadata = {
                **(context.metadata or {}),
                "opencode_pricing_source": "missing_usage",
            }
            return
        reported_cost = context.cost_usd
        estimated_cost = context.cost_usd
        pricing_source = "opencode" if estimated_cost is not None else None

        pricing = pricing_from_env(self._get_env)
        if pricing is not None:
            estimated_cost = estimate_cost(totals, pricing)
            context.cost_usd = estimated_cost
            pricing_source = self._get_env("MAKA_TRIAL_PRICING_SOURCE") or "env"

        context.metadata = {
            **(context.metadata or {}),
            "opencode_input_tokens": totals["input"],
            "opencode_output_tokens": totals["output"],
            "opencode_cached_input_tokens": totals["cache_read"],
            "opencode_cache_hit_input_tokens": totals["cache_read"],
            "opencode_cache_miss_input_tokens": totals["cache_miss"],
            "opencode_cache_write_input_tokens": totals["cache_write"],
            "opencode_estimated_cost_usd": estimated_cost,
            "opencode_reported_cost_usd": reported_cost,
            "opencode_pricing_source": pricing_source or "missing_pricing",
        }

    @staticmethod
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

    async def _run_with_stop_sentinel(
        self,
        instruction: str,
        environment: BaseEnvironment,
    ) -> None:
        self._instruction = instruction
        escaped_instruction = shlex.quote(instruction)

        if not self.model_name or "/" not in self.model_name:
            raise ValueError("Model name must be in the format provider/model_name")

        provider, _ = self.model_name.split("/", 1)
        provider_env_names = {
            "zai-coding-plan": ("ZAI_BASE_URL", "ZAI_API_KEY"),
            "kimi-coding-plan": ("KIMI_BASE_URL", "KIMI_API_KEY"),
            "deepseek": ("DEEPSEEK_BASE_URL", "DEEPSEEK_API_KEY"),
        }
        if provider not in provider_env_names:
            raise ValueError(f"Unsupported Maka OpenCode benchmark provider: {provider}")
        proxy_url = self._get_env("MAKA_PROVIDER_PROXY_URL")
        proxy_token = self._get_env("MAKA_PROVIDER_PROXY_TOKEN")
        if not proxy_url or not proxy_token:
            raise ValueError(f"{provider} requires the host provider proxy")
        env = self._provider_env(provider)
        base_url_env, api_key_env = provider_env_names[provider]
        env[base_url_env] = proxy_url
        env[api_key_env] = proxy_token
        env["OPENCODE_CONFIG"] = self._opencode_config_path()
        env["OPENCODE_FAKE_VCS"] = "git"

        skills_command = self._build_register_skills_command()
        if skills_command:
            await self.exec_as_agent(environment, command=skills_command, env=env)

        mcp_command = self._build_register_config_command()
        if mcp_command:
            await self.exec_as_agent(environment, command=mcp_command, env=env)

        cli_flags = self.build_cli_flags()
        cli_flags_arg = (cli_flags + " ") if cli_flags else ""
        variant = self._get_env("MAKA_OPENCODE_VARIANT")
        if variant not in (None, "high", "max"):
            raise ValueError(f"Unsupported OpenCode variant: {variant}")
        variant_arg = f"--variant={shlex.quote(variant)} " if variant else ""
        runner_path = self._stop_runner_path()
        grace_ms = self._stop_grace_ms()
        command = (
            f"{shlex.quote(str(_TOOLCHAIN_NODE))} {shlex.quote(runner_path)} "
            "--output /logs/agent/opencode.txt "
            f"--grace-ms {grace_ms} "
            "-- "
            f"{shlex.quote(str(_TOOLCHAIN_OPENCODE))} --model={shlex.quote(self.model_name)} run --format=json --pure "
            f"{cli_flags_arg}{variant_arg}--thinking --auto -- "
            f"{escaped_instruction}"
        )
        self._write_execution_identity()
        await self.exec_as_agent(environment, command=command, env=env)

    def _stop_runner_path(self) -> str:
        maka_repo = self._get_env("MAKA_REPO_ROOT") or "/opt/maka-agent"
        return str(
            Path(maka_repo)
            / "packages"
            / "headless"
            / "harbor"
            / "opencode-stop-runner.mjs"
        )

    def _opencode_config_path(self) -> str:
        maka_repo = self._get_env("MAKA_REPO_ROOT") or "/opt/maka-agent"
        return str(
            Path(maka_repo)
            / "packages"
            / "headless"
            / "harbor"
            / "opencode-benchmark.json"
        )

    def _stop_grace_ms(self) -> int:
        raw = self._get_env("MAKA_OPENCODE_STOP_GRACE_MS")
        if raw is None:
            return 2000
        try:
            value = int(raw)
        except (TypeError, ValueError):
            return 2000
        return max(0, value)

    def _provider_env(self, provider: str) -> dict[str, str]:
        env: dict[str, str] = {}
        for key in ("XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME"):
            value = self._get_env(key)
            if value:
                env[key] = value
        return env

    def _token_totals(self, context: AgentContext) -> dict[str, int] | None:
        parsed = self._token_totals_from_stdout()
        if parsed is not None:
            return parsed

        raw_input = getattr(context, "n_input_tokens", None)
        raw_output = getattr(context, "n_output_tokens", None)
        raw_cache_read = getattr(context, "n_cache_tokens", None)
        if raw_input is None and raw_output is None and raw_cache_read is None:
            return None
        input_tokens = int(raw_input or 0)
        output_tokens = int(raw_output or 0)
        cache_read = int(raw_cache_read or 0)
        cache_miss = max(0, input_tokens - cache_read)
        return {
            "input": input_tokens,
            "output": output_tokens,
            "cache_read": cache_read,
            "cache_write": 0,
            "cache_miss": cache_miss,
            "reasoning": 0,
        }

    def _token_totals_from_stdout(self) -> dict[str, int] | None:
        if not hasattr(self, "_parse_stdout"):
            return None
        events = self._parse_stdout()
        if not events:
            return None

        input_tokens = 0
        output_tokens = 0
        cache_read = 0
        cache_write = 0
        reasoning = 0
        saw_tokens = False
        for event in events:
            if event.get("type") != "step_finish":
                continue
            part = event.get("part")
            if not isinstance(part, dict):
                continue
            tokens = part.get("tokens")
            if not isinstance(tokens, dict):
                continue
            saw_tokens = True
            step_input = _int_value(tokens.get("input"))
            step_output = _int_value(tokens.get("output"))
            step_reasoning = _int_value(tokens.get("reasoning"))
            cache = tokens.get("cache")
            step_cache_read = (
                _int_value(cache.get("read")) if isinstance(cache, dict) else 0
            )
            step_cache_write = (
                _int_value(cache.get("write")) if isinstance(cache, dict) else 0
            )
            input_tokens += step_input + step_cache_read + step_cache_write
            output_tokens += step_output + step_reasoning
            cache_read += step_cache_read
            cache_write += step_cache_write
            reasoning += step_reasoning

        if not saw_tokens:
            return None

        return {
            "input": input_tokens,
            "output": output_tokens,
            "cache_read": cache_read,
            "cache_write": cache_write,
            "cache_miss": max(0, input_tokens - cache_read - cache_write),
            "reasoning": reasoning,
        }

    def _write_cell_output(self, context: AgentContext) -> None:
        totals = self._token_totals(context)
        started_at = getattr(self, "_started_at_ms", int(time.time() * 1000))
        finished_at = getattr(self, "_finished_at_ms", started_at)
        execution_identity = self._execution_identity()
        prompt_hash = execution_identity["systemPromptHash"]
        events = self._parse_stdout() if hasattr(self, "_parse_stdout") else []
        tool_call_counts: dict[str, int] = {}
        for event in events or []:
            part = event.get("part")
            if not isinstance(part, dict) or part.get("type") not in ("tool", "tool-invocation"):
                continue
            tool_name = part.get("tool")
            if tool_name:
                name = str(tool_name)
                tool_call_counts[name] = tool_call_counts.get(name, 0) + 1
        tool_names = sorted(tool_call_counts)
        token_summary = None
        if totals is not None and context.cost_usd is not None:
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
                "costUsd": float(context.cost_usd),
                "pricingSource": "runtime",
            }
        self.logs_dir.mkdir(parents=True, exist_ok=True)
        runtime_events_path = self.logs_dir / "runtime-events.jsonl"
        source_events_path = self.logs_dir / "opencode.txt"
        runtime_events_path.write_text(
            source_events_path.read_text(encoding="utf-8") if source_events_path.exists() else "",
            encoding="utf-8",
        )
        output = {
            "schemaVersion": 1,
            "status": "failed" if hasattr(self, "_failure_class") else "completed",
            **({"errorClass": self._failure_class} if hasattr(self, "_failure_class") else {}),
            "runtimeEventsPath": "/logs/agent/runtime-events.jsonl",
            "promptHash": prompt_hash,
            "executionIdentity": execution_identity,
            **({"tokenSummary": token_summary} if token_summary is not None else {}),
            "toolSummary": {
                "providerVisibleToolCount": 0,
                "actualToolCalls": sum(tool_call_counts.values()),
                "actualToolNames": tool_names,
                "actualToolCallCounts": tool_call_counts,
            },
            "steps": sum(1 for event in events or [] if event.get("type") == "step_finish"),
            "durationMs": max(0, finished_at - started_at),
            "startedAt": started_at,
            "finishedAt": finished_at,
            "runtimeRefs": {
                "invocationId": "opencode",
                "sessionId": "opencode",
                "runId": "opencode",
                "turnId": "opencode",
            },
        }
        (self.logs_dir / "maka-cell-output.json").write_text(
            json.dumps(output, indent=2) + "\n", encoding="utf-8"
        )

    def _execution_identity(self) -> dict[str, Any]:
        provider, model = self.model_name.split("/", 1)
        system_prompt = self._get_env("MAKA_SYSTEM_PROMPT") or ""
        prompt_hash = "sha256:" + hashlib.sha256(
            json.dumps(system_prompt, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        ).hexdigest()
        pricing_profile = self._get_env("MAKA_TRIAL_PRICING_SOURCE") or "unconfigured"
        reasoning_effort = self._get_env("MAKA_REASONING_EFFORT")
        return {
            "llmConnectionSlug": self._get_env("MAKA_LLM_CONNECTION_SLUG") or provider,
            "model": model,
            **({"reasoningEffort": reasoning_effort} if reasoning_effort else {}),
            "systemPromptHash": prompt_hash,
            "pricingProfile": pricing_profile,
            "agentTools": False,
        }

    def _write_execution_identity(self) -> None:
        self.logs_dir.mkdir(parents=True, exist_ok=True)
        path = self.logs_dir / "maka-cell-execution-identity.json"
        with path.open("w", encoding="utf-8") as output:
            output.write(json.dumps(self._execution_identity(), indent=2) + "\n")
            output.flush()
            os.fsync(output.fileno())

def _int_value(value: Any) -> int:
    return (
        int(value)
        if isinstance(value, (int, float)) and not isinstance(value, bool)
        else 0
    )
