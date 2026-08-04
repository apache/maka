"""Harbor adapter for the pinned official Reasonix CLI."""

from __future__ import annotations

import hashlib
import json
import os
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
    with_prompt_template,
)
from process_scope import cleanup_process_scope, scoped_command

_TOOLCHAIN_ROOT = Path("/opt/maka-reasonix-toolchain")
# Reasonix is a static Go binary; the pinned Node next to it is only the offline
# manifest verifier install() runs, exactly as for the prebuilt OpenCode binary.
_TOOLCHAIN_NODE = _TOOLCHAIN_ROOT / "bin" / "node"
_TOOLCHAIN_BINARY = _TOOLCHAIN_ROOT / "bin" / "reasonix"
_TOOLCHAIN_MANIFEST = _TOOLCHAIN_ROOT / "manifest.json"
_TOOLCHAIN_CHECKSUMS = _TOOLCHAIN_ROOT / "checksums.sha256"
_OUTPUT_PATH = Path("/logs/agent/reasonix.jsonl")
_REASONIX_HOME = Path("/tmp/maka-reasonix")
# Reasonix resolves api_key_env against its own credential store
# ($REASONIX_HOME/.env), NOT the process environment — see
# ProviderEntry.APIKey -> storedCredentialValue in internal/config. So the
# config file names the key and this file holds it, both inside an isolated
# home outside the task workspace. A Maka-specific name keeps the cell-scoped
# proxy token clear of any DEEPSEEK_API_KEY a stray environment might define.
_REASONIX_CREDENTIALS = _REASONIX_HOME / ".env"
_PROXY_TOKEN_ENV = "MAKA_REASONIX_PROXY_TOKEN"
# A reserved provider name: it cannot collide with Reasonix's built-in deepseek
# entry, so the proxy route is unambiguous regardless of what else resolves.
_PROVIDER_NAME = "maka-proxy"
_DEFAULT_EFFORT = "max"


class MakaReasonixAgent(BaseInstalledAgent):
    """Run Reasonix in deterministic print mode for a single Harbor task."""

    @staticmethod
    def name() -> str:
        return "reasonix"

    def install_spec(self) -> None:
        # The Reasonix toolchain is baked into the task image and only verified
        # (sha256 checksums + manifest fingerprint) in install(); there is
        # nothing to install at Pier build time. Pier declares this abstract on
        # BaseInstalledAgent; None keeps the runtime verify path unchanged.
        return None

    def get_version_command(self) -> str | None:
        return f"{shlex.quote(str(_TOOLCHAIN_BINARY))} --version"

    async def install(self, environment: BaseEnvironment) -> None:
        expected_fingerprint = self._get_env("MAKA_REASONIX_TOOLCHAIN_FINGERPRINT")
        if not expected_fingerprint:
            raise ValueError("MAKA_REASONIX_TOOLCHAIN_FINGERPRINT is required")
        manifest_check = (
            "const fs = require('node:fs'); "
            "const manifest = JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); "
            "if (manifest.fingerprint !== process.env.MAKA_EXPECTED_TOOLCHAIN_FINGERPRINT) "
            "throw new Error('Reasonix toolchain fingerprint mismatch');"
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
                # umask before any write: the credential file must never exist
                # group- or world-readable, not even momentarily.
                "umask 077; "
                f"mkdir -p {shlex.quote(str(_REASONIX_HOME))}; "
                f"printf %s {shlex.quote(self._config_toml())} > "
                f"{shlex.quote(str(_REASONIX_HOME / 'config.toml'))}; "
                # Reasonix resolves api_key_env from its own credential store,
                # not the process environment, so the token has to reach that
                # file. It is expanded from the environment here rather than
                # interpolated, so the value never enters the command line,
                # the process table, or Harbor's command logs.
                f"printf '%s=%s\\n' {shlex.quote(_PROXY_TOKEN_ENV)} "
                f'"${_PROXY_TOKEN_ENV}" > '
                f"{shlex.quote(str(_REASONIX_CREDENTIALS))}; "
                f"{shlex.quote(str(_TOOLCHAIN_BINARY))} run --auto "
                f"--model {shlex.quote(self._model_reference())} "
                f"--effort {shlex.quote(self._effort())} "
                "--output-format stream-json "
                f"{shlex.quote(instruction)} "
                f"> {shlex.quote(str(_OUTPUT_PATH))} "
                "2> /logs/agent/reasonix.stderr.txt"
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
        # CLI writes to /logs/agent/reasonix.jsonl (identity and timestamps are
        # host-side). Whenever the agent log dir is bind-mounted the file is
        # already host-side and this is a no-op; the download is the fallback
        # for every executor that does not mount it, because without the stream
        # _events() sees nothing and a real token-burning run is misclassified
        # as infra. Runs in run()'s finally so the AgentTimeoutError path is
        # hydrated too. Same shape as the other installed-agent adapters.
        local = self.logs_dir / _OUTPUT_PATH.name
        if local.exists():
            return
        try:
            await environment.download_file(_OUTPUT_PATH.as_posix(), local)
        except Exception as exc:  # noqa: BLE001 - best-effort log hydration.
            self.logger.debug("Could not download Reasonix stream %s: %s", _OUTPUT_PATH, exc)

    def populate_context_post_run(self, context: AgentContext) -> None:
        self._write_cell_output()

    def _model(self) -> str:
        model = self._get_env("MAKA_MODEL") or self.model_name
        if not model:
            raise ValueError("MAKA_MODEL is required")
        return model

    def _model_reference(self) -> str:
        return f"{_PROVIDER_NAME}/{self._model()}"

    def _effort(self) -> str:
        return self._get_env("MAKA_REASONING_EFFORT") or _DEFAULT_EFFORT

    def _config_toml(self) -> str:
        proxy_url = self._get_env("MAKA_PROVIDER_PROXY_URL")
        if not proxy_url:
            raise ValueError("Reasonix requires the host provider proxy")
        model = self._model()
        # Reasonix has no flag or environment override for a provider base_url,
        # so the proxy route has to come from config. Only non-secret values are
        # written here: the key itself is resolved from api_key_env at runtime.
        # Model and effort are also pinned as flags, which outrank config; both
        # are declared so a dropped flag cannot silently downgrade the arm.
        return (
            f"default_model = {_toml_string(f'{_PROVIDER_NAME}/{model}')}\n"
            "\n"
            "[[providers]]\n"
            f"name = {_toml_string(_PROVIDER_NAME)}\n"
            'kind = "openai"\n'
            f"base_url = {_toml_string(proxy_url)}\n"
            f"models = [{_toml_string(model)}]\n"
            f"api_key_env = {_toml_string(_PROXY_TOKEN_ENV)}\n"
            f"effort = {_toml_string(self._effort())}\n"
            "\n"
            # Reasonix defaults to bash = "enforce", which jails each command in
            # an OS sandbox and REFUSES to run bash at all when none is
            # available. Terminal-Bench images do not ship bubblewrap, so the
            # default silently disables the agent's most important tool: the
            # first live cell spent its whole run writing a setup script it was
            # never allowed to execute. The Harbor task container is already the
            # isolation boundary — that is the declared execution policy, and
            # every other arm runs its commands unconfined inside it. Turning
            # this off puts Reasonix on the same footing rather than handing it
            # an advantage.
            "[sandbox]\n"
            'bash = "off"\n'
        )

    def _runtime_env(self) -> dict[str, str]:
        # The proxy URL is forwarded opaquely (IPv6 included): endpoint-shape
        # validation is a Pier egress-allowlist concern, and this arm runs only
        # under plain Harbor (see PierAgent in pier-task-runner.ts).
        proxy_token = self._get_env("MAKA_PROVIDER_PROXY_TOKEN")
        if not proxy_token:
            raise ValueError("Reasonix requires the host provider proxy")
        return {
            # An isolated home keeps Reasonix's config, session state, and
            # credential file off any host or task-workspace config that could
            # redirect the run.
            "REASONIX_HOME": str(_REASONIX_HOME),
            # This carries the cell-scoped proxy token into the container so the
            # command can expand it into Reasonix's credential file without ever
            # naming the value itself. The upstream provider key stays host-side
            # in the proxy and never enters the container in any form.
            _PROXY_TOKEN_ENV: proxy_token,
        }

    def _events(self, *, require_result: bool = False) -> list[dict[str, Any]]:
        path = self.logs_dir / _OUTPUT_PATH.name
        if not path.exists():
            if require_result:
                raise ValueError("Reasonix stream-json did not contain a result object")
            return []
        events = []
        for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
            if not line.strip():
                continue
            try:
                value = json.loads(line)
            except json.JSONDecodeError as error:
                if require_result:
                    raise ValueError(
                        f"Reasonix stream-json line {line_number} is not valid JSON"
                    ) from error
                continue
            if not isinstance(value, dict):
                if require_result:
                    raise ValueError(
                        f"Reasonix stream-json line {line_number} must be a JSON object"
                    )
                continue
            events.append(value)
        if require_result and _result_object(events) is None:
            raise ValueError("Reasonix stream-json did not contain a result object")
        return events

    def _write_cell_output(self) -> None:
        started_at = getattr(self, "_started_at_ms", int(time.time() * 1000))
        finished_at = getattr(self, "_finished_at_ms", started_at)
        identity = self._execution_identity()
        failed = hasattr(self, "_failure_class")
        events = self._events(require_result=not failed)
        result = _result_object(events)
        tool_call_counts: dict[str, int] = {}
        for event in events:
            # tool_result and tool_progress repeat a dispatched call; only
            # tool_dispatch marks a distinct invocation.
            if event.get("kind") != "tool_dispatch":
                continue
            tool = event.get("tool")
            name = tool.get("name") if isinstance(tool, dict) else None
            if name:
                key = str(name)
                tool_call_counts[key] = tool_call_counts.get(key, 0) + 1
        session_id = "reasonix"
        steps = 0
        error_class: str | None = self._failure_class if failed else None
        if result is not None:
            if isinstance(result.get("session_id"), str) and result["session_id"]:
                session_id = result["session_id"]
            if isinstance(result.get("num_turns"), int):
                steps = max(0, result["num_turns"])
            if result.get("is_error") is True:
                # Reasonix binds its verdict to its exit code: every
                # error_during_execution also exits 1 (internal/cli/
                # run_completion.go), so run() has already raised and classified
                # from Harbor's exception text. That text embeds the whole
                # command line, including the task instruction, whose wording
                # can match the infrastructure markers by chance — and its
                # fallthrough is infra_failed, which drops the cell out of the
                # scored denominator.
                #
                # A run that wrote a terminal result object reached the model
                # and burned tokens, so it is an agent outcome no matter how the
                # message reads. Re-scanning that message for markers would
                # reintroduce the same coincidence it exists to defeat, this
                # time on prose the model itself wrote. Scoring a provider-side
                # failure as an agent loss is the honest direction; silently
                # shrinking the denominator is not.
                error_class = "runtime_error"
        self.logs_dir.mkdir(parents=True, exist_ok=True)
        runtime_events_path = self.logs_dir / "runtime-events.jsonl"
        source_path = self.logs_dir / _OUTPUT_PATH.name
        runtime_events_path.write_text(
            source_path.read_text(encoding="utf-8") if source_path.exists() else "",
            encoding="utf-8",
        )
        output = {
            "schemaVersion": 1,
            "status": "failed" if error_class else "completed",
            **({"errorClass": error_class} if error_class else {}),
            "runtimeEventsPath": "/logs/agent/runtime-events.jsonl",
            "promptHash": identity["systemPromptHash"],
            "executionIdentity": identity,
            "toolSummary": {
                "providerVisibleToolCount": 0,
                "actualToolCalls": sum(tool_call_counts.values()),
                "actualToolNames": sorted(tool_call_counts),
                "actualToolCallCounts": tool_call_counts,
            },
            "steps": steps,
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
        return {
            "llmConnectionSlug": self._get_env("MAKA_LLM_CONNECTION_SLUG") or "deepseek",
            "model": self._get_env("MAKA_MODEL") or self.model_name or "deepseek-v4-flash",
            "reasoningEffort": self._effort(),
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


def _toml_string(value: str) -> str:
    """Render a TOML basic string; JSON string escaping is a valid subset."""
    return json.dumps(value, ensure_ascii=False)


def _result_object(events: list[dict[str, Any]]) -> dict[str, Any] | None:
    # stream-json emits one eventwire object per line, then the final result
    # object; the result is the only line keyed by "type" instead of "kind".
    for event in reversed(events):
        if event.get("type") == "result":
            return event
    return None


def _classify_failure(error: Exception) -> str:
    # Only reachable when the run left no terminal result object to trust, so
    # Harbor's exception text is the only signal there is.
    text = str(error).lower()
    if any(
        marker in text
        for marker in ("401", "403", "unauthorized", "authentication", "invalid api key")
    ):
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
