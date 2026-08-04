"""Harbor adapter for running a Maka RuntimeRunner cell in the task workdir."""

from __future__ import annotations

import asyncio
import concurrent.futures
import contextlib
import json
import os
import re
import secrets
import shlex
import shutil
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

# harness_compat picks the harbor.* tree under plain Harbor 0.13.2 and the
# pier.* tree under Pier, whose parallel classes are type-incompatible with
# harbor's (Pier's TrialResult only accepts Pier's AgentInfo).
from harness_compat import (
    Agent,
    AgentContext,
    BaseEnvironment,
    BaseInstalledAgent,
    CliFlag,
    EnvironmentPaths,
    FinalMetrics,
    NetworkAllowlist as _NetworkAllowlist,
    Step,
    Trajectory,
    format_trajectory_json,
    with_prompt_template,
)
from maka_trajectory import (
    load_runtime_trajectory,
    redact_value,
    referenced_image_artifact_paths,
)
from process_scope import (
    COMMAND_SCOPE_ENV as _COMMAND_SCOPE_ENV,
    COMMAND_SCOPE_ROOT as _COMMAND_SCOPE_ROOT,
    exec_cleanup_command as _exec_cleanup_command,
    scoped_command as _scoped_command,
    scoped_command_cleanup_command as _scoped_command_cleanup_command,
    scoped_process_cleanup_command as _scoped_process_cleanup_command,
)
from provider_proxy import provider_proxy_endpoint, warn_if_pier_unreachable_proxy_port
from trial_pricing import estimate_cost, pricing_from_env

# Default wall-clock budget for a single bridged tool command when the client
# does not request its own timeout. Matches the in-container executor floor
# (HARBOR_CELL_DEFAULT_COMMAND_TIMEOUT_MS = 120_000) rather than the whole-cell
# budget, so an individual command cannot silently borrow the 15-minute cell
# deadline.
_BRIDGE_DEFAULT_TIMEOUT_SEC = 120

# Location of this adapter and the repo it ships in. The task-run host mode
# spawns `node <repo>/packages/headless/dist/cli.js` on the host, so it needs to
# find the built headless CLI relative to this file when no explicit repo root
# env is set.
_HARBOR_DIR = Path(__file__).resolve().parent
_HEADLESS_DIR = _HARBOR_DIR.parent
_REPO_ROOT_DEFAULT = _HEADLESS_DIR.parent.parent
_CONTAINER_MAKA_REPO = Path("/opt/maka-agent")
_CONTAINER_HEADLESS_CLI = _CONTAINER_MAKA_REPO / "packages" / "headless" / "dist" / "cli.js"
_MAKA_NODE_TOOLCHAIN_ROOT = Path("/opt/maka-node-toolchain")
_MAKA_NODE_TOOLCHAIN_NODE = _MAKA_NODE_TOOLCHAIN_ROOT / "bin" / "node"
_MAKA_NODE_TOOLCHAIN_MANIFEST = _MAKA_NODE_TOOLCHAIN_ROOT / "manifest.json"
_MAKA_NODE_TOOLCHAIN_CHECKSUMS = _MAKA_NODE_TOOLCHAIN_ROOT / "checksums.sha256"
_DEFAULT_RUNNER_ENV = Path(
    os.environ.get(
        "MAKA_HARBOR_RUNNER_ENV_FILE",
        str(Path.home() / ".config" / "maka" / "harbor-runner.env"),
    )
)


_HOST_NODE_ENV_ALLOWLIST = {
    "PATH",
    "TMPDIR",
    "TEMP",
    "TMP",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS",
    # Host-side model requests must retain the operator's standard Node proxy
    # configuration. NO_PROXY keeps the localhost tool bridge direct. These
    # values reach only the trusted host child, never the task container.
    "NODE_USE_ENV_PROXY",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
    # Windows-specific variables Node/OpenSSL need to initialize the CSPRNG
    # and resolve system paths when the host cell is launched from a subprocess.
    "SystemRoot",
    "WINDIR",
    "USERPROFILE",
    "LOCALAPPDATA",
    "COMSPEC",
}

_HOST_PROVIDER_AUTHORITY_ENV_KEYS = (
    "MAKA_HOST_API_KEY",
    "MAKA_HOST_API_KEY_FILE",
    "MAKA_HOST_NO_AUTH",
    "MAKA_HOST_BASE_URL",
    "MAKA_HOST_MODEL_API_PROTOCOL",
)

def _host_node_process_env(cell_env: dict[str, str]) -> dict[str, str]:
    env = {key: value for key in _HOST_NODE_ENV_ALLOWLIST if (value := os.environ.get(key))}
    env.update(cell_env)
    return env


# 2^53 - 1, matches JS Number.MAX_SAFE_INTEGER so the TS host and this adapter
# agree on the upper bound for MAKA_CELL_TIMEOUT_SEC; an over-long digit string
# is malformed, not a giant timeout.
_MAX_SAFE_INTEGER = 9007199254740991
_MAX_NODE_TIMER_MS = 2_147_483_647
# ASCII decimal positive integer literal only; [0-9] (not \d) rejects Unicode
# digits on both sides. Matches the TS host's lenientPositiveIntEnv.
_POSITIVE_INT_RE = re.compile(r"[1-9][0-9]*")


def _positive_int_literal(raw: str | None) -> int | None:
    if not raw:
        return None
    stripped = raw.strip()
    if _POSITIVE_INT_RE.fullmatch(stripped) is None:
        return None
    try:
        value = int(stripped)
    except ValueError:
        # CPython caps integer-string conversion length; an over-long value is malformed.
        return None
    return value if value <= _MAX_SAFE_INTEGER else None


class MakaAgent(BaseInstalledAgent):
    """Run Maka inside the Harbor task container and expose the shared cell output."""

    SUPPORTS_ATIF = True

    _RUN_LOG_FILENAME = "maka-run.log"
    _CELL_OUTPUT_FILENAME = "maka-cell-output.json"
    _CELL_USAGE_CHECKPOINT_FILENAME = "maka-cell-usage-checkpoint.json"
    _CELL_EXECUTION_IDENTITY_FILENAME = "maka-cell-execution-identity.json"
    _RUNTIME_EVENTS_FILENAME = "runtime-events.jsonl"
    _TRACE_EVENTS_FILENAME = "trace-events.jsonl"

    CLI_FLAGS = [
        CliFlag(
            "system_prompt",
            cli="",
            type="str",
            default="",
            env_fallback="MAKA_SYSTEM_PROMPT",
        ),
        CliFlag(
            "maka_repo",
            cli="",
            type="str",
            default="/opt/maka-agent",
            env_fallback="MAKA_REPO_ROOT",
        ),
        CliFlag(
            "backend",
            cli="",
            type="str",
            default="ai-sdk",
            env_fallback="MAKA_BACKEND",
        ),
        CliFlag(
            "provider",
            cli="",
            type="str",
            default="",
            env_fallback="MAKA_PROVIDER",
        ),
        CliFlag(
            "economy_task_mode",
            cli="",
            type="bool",
            default=False,
            env_fallback="MAKA_ECONOMY_TASK_MODE",
        ),
    ]

    @staticmethod
    def name() -> str:
        return "maka"

    def install_spec(self) -> None:
        # Maka installs at runtime inside install()/setup() (host-side Node, or
        # the in-container Node bootstrap), not via a Pier build-time install
        # spec. Pier declares this abstract on BaseInstalledAgent; returning
        # None keeps the runtime-install path unchanged (Pier runs install()
        # when no spec is preinstalled).
        return None

    def network_allowlist(self) -> _NetworkAllowlist | None:
        # Called only under Pier; plain Harbor never calls it and harness_compat
        # exports NetworkAllowlist = None there.
        if _NetworkAllowlist is None:
            return None
        if self._task_run_in_container():
            if self._harbor_backend() == "fake":
                return _NetworkAllowlist()
            hostname, port = provider_proxy_endpoint(self._get_env, "Maka")
            warn_if_pier_unreachable_proxy_port(port, "Maka")
            return _NetworkAllowlist(domains=[hostname])
        # The empty allowlist keeps a non-internet Pier task fully offline,
        # which is correct exactly when the container makes no model calls. A
        # configuration whose cell would call the provider from inside the
        # container would hit opaque in-container network errors, so fail at
        # environment creation with the fixes spelled out.
        if self._container_makes_model_calls():
            raise RuntimeError(
                "MakaAgent under Pier keeps the task container offline; enable "
                "host-side provider configuration (MAKA_HOST_API_KEY_FILE, "
                "MAKA_HOST_API_KEY, or MAKA_HOST_NO_AUTH=true), use "
                "backend=fake, or run MAKA_HARBOR_MODE=task-run"
            )
        return _NetworkAllowlist()

    def _container_makes_model_calls(self) -> bool:
        """True only when the in-container cell itself calls the model provider.

        Pier task-run runs the model in the container through the host proxy.
        Cell mode does so only without host-side LLM configuration. The fake
        backend never calls a model provider.
        """
        return (
            self._harbor_backend() != "fake"
            and (
                self._task_run_in_container()
                or (
                    self._harbor_mode() == "cell"
                    and not self._host_side_llm_enabled()
                )
            )
        )

    def _task_run_in_container(self) -> bool:
        """Pier task runs execute in the task container; plain Harbor keeps its
        existing host bridge for Terminal-Bench callers."""
        return self._harbor_mode() == "task-run" and _NetworkAllowlist is not None

    def _harbor_mode(self) -> str:
        """cell (default) runs a RuntimeRunner cell. task-run runs the full
        controller inside Pier's task container, while plain Harbor retains
        the host controller and shared _ToolExecutorServer bridge."""
        mode = (self._get_env("MAKA_HARBOR_MODE") or "cell").strip()
        if mode not in ("cell", "task-run"):
            raise RuntimeError(f"MAKA_HARBOR_MODE must be cell or task-run, got {mode!r}")
        return mode

    def get_version_command(self) -> str | None:
        if self._harbor_mode() == "task-run":
            return (
                f"{shlex.quote(str(_MAKA_NODE_TOOLCHAIN_NODE))} --version"
                if self._task_run_in_container()
                else None
            )
        return "node --version"

    async def install(self, environment: BaseEnvironment) -> None:
        if self._harbor_mode() == "task-run":
            if self._task_run_in_container():
                expected_fingerprint = self._get_env("MAKA_NODE_TOOLCHAIN_FINGERPRINT")
                if not expected_fingerprint:
                    raise ValueError("MAKA_NODE_TOOLCHAIN_FINGERPRINT is required")
                manifest_check = (
                    "const fs = require('node:fs'); "
                    "const manifest = JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); "
                    "if (manifest.fingerprint !== process.env.MAKA_EXPECTED_TOOLCHAIN_FINGERPRINT) "
                    "throw new Error('Maka Node toolchain fingerprint mismatch');"
                )
                command = (
                    "set -euo pipefail; "
                    'test "$(uname -s)" = Linux; '
                    'test "$(uname -m)" = x86_64; '
                    f"cd {shlex.quote(str(_MAKA_NODE_TOOLCHAIN_ROOT))}; "
                    f"sha256sum --check {shlex.quote(_MAKA_NODE_TOOLCHAIN_CHECKSUMS.name)}; "
                    f"{shlex.quote(str(_MAKA_NODE_TOOLCHAIN_NODE))} "
                    f"-e {shlex.quote(manifest_check)} "
                    f"{shlex.quote(str(_MAKA_NODE_TOOLCHAIN_MANIFEST))}; "
                    f"test -f {shlex.quote(str(_CONTAINER_HEADLESS_CLI))}"
                )
                await self.exec_as_agent(
                    environment,
                    command=command,
                    env={"MAKA_EXPECTED_TOOLCHAIN_FINGERPRINT": expected_fingerprint},
                )
                return
            # Host-bridge task-run: node and the headless CLI run on the host and
            # bridge tool execution into the task container, so nothing installs
            # inside the task. Fail fast if the built CLI is missing.
            cli_path = self._headless_cli_path()
            if not cli_path.is_file():
                raise RuntimeError(
                    f"headless CLI not built at {cli_path}; run `npm run build` in packages/headless"
                )
            return
        maka_repo = self._resolved_flags.get("maka_repo", "/opt/maka-agent")
        self._harbor_backend()
        run_cell = (Path(maka_repo) / "packages" / "headless" / "harbor" / "run-cell.mjs").as_posix()
        run_host_cell = (Path(maka_repo) / "packages" / "headless" / "harbor" / "run-host-cell.mjs").as_posix()
        dist_index = (Path(maka_repo) / "packages" / "headless" / "dist" / "index.js").as_posix()
        dist_harbor_cell = (Path(maka_repo) / "packages" / "headless" / "dist" / "harbor-cell.js").as_posix()
        if self._host_side_llm_enabled():
            await self.exec_as_agent(
                environment,
                command=(
                    f"test -f {shlex.quote(run_host_cell)} && "
                    f"test -f {shlex.quote(dist_harbor_cell)}"
                ),
            )
            return
        # The bootstrap downloads (apt/yum/apk packages, the nvm installer, the
        # node tarball) are this adapter's only container-side network
        # dependency. It cannot see the task's allow_internet setting, so an
        # offline container (every Pier non-internet task) surfaces here as
        # obscure curl/apt errors; name the cause and the ways out at the point
        # of failure instead.
        node_bootstrap = (
            "if command -v apt-get >/dev/null 2>&1; then apt-get update && apt-get install -y curl ca-certificates; "
            "elif command -v yum >/dev/null 2>&1; then yum install -y curl ca-certificates; "
            "elif command -v apk >/dev/null 2>&1; then apk add --no-cache curl ca-certificates; "
            "fi; "
            "export NVM_DIR=\"/usr/local/nvm\"; "
            "mkdir -p \"$NVM_DIR\"; "
            "curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.2/install.sh | PROFILE=/dev/null bash; "
            ". \"$NVM_DIR/nvm.sh\"; "
            "nvm install 22; "
            "nvm alias default 22; "
            "chmod -R a+rX \"$NVM_DIR\"; "
            "for bin in node npm npx; do "
            "  BIN_PATH=\"$(. \"$NVM_DIR/nvm.sh\" && which \"$bin\")\"; "
            "  ln -sf \"$BIN_PATH\" \"/usr/local/bin/$bin\"; "
            "done"
        )
        bootstrap_failed = (
            "Maka Node >= 22 bootstrap failed. It downloads packages and nvm, "
            "which needs container network access; under Pier non-internet "
            "tasks the container is offline. Use a task image with Node >= 22 "
            "preinstalled or host-side LLM mode."
        )
        await self.exec_as_root(
            environment,
            command=(
                "set -euo pipefail; "
                "NODE_MAJOR=$(node -p 'process.versions.node.split(\".\")[0]' 2>/dev/null || echo 0); "
                "if [ \"$NODE_MAJOR\" -lt 22 ]; then "
                # A child shell keeps first-failure abort semantics (`||` on the
                # same shell would suppress set -e inside the guarded commands)
                # and lets any failure collapse into one clear diagnostic.
                f"bash -euo pipefail -c {shlex.quote(node_bootstrap)} || "
                f"{{ echo {shlex.quote(bootstrap_failed)} >&2; exit 1; }}; "
                "fi"
            ),
        )
        await self.exec_as_agent(
            environment,
            command=(
                "node --version && "
                "NODE_MAJOR=$(node -p 'process.versions.node.split(\".\")[0]') && "
                "test \"$NODE_MAJOR\" -ge 22 && "
                f"test -f {shlex.quote(run_cell)} && "
                f"test -f {shlex.quote(run_host_cell)} && "
                f"test -f {shlex.quote(dist_index)}"
            ),
        )

    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        if self._harbor_mode() == "task-run":
            if self._task_run_in_container():
                phase_started_monotonic = time.monotonic()
                phase_timeout_sec = _positive_int_literal(
                    self._get_env("MAKA_AGENT_PHASE_TIMEOUT_SEC")
                )
                model_deadline_at_ms = (
                    time.time_ns() // 1_000_000 + self._cell_timeout_sec() * 1000
                    if phase_timeout_sec is not None
                    else None
                )
                await self._run_task_run_container(
                    instruction,
                    environment,
                    context,
                    phase_started_monotonic=phase_started_monotonic,
                    model_deadline_at_ms=model_deadline_at_ms,
                )
            else:
                await self._run_task_run_host(instruction, environment, context)
            return
        agent_dir = EnvironmentPaths.agent_dir
        await self.exec_as_agent(environment, command=f"mkdir -p {agent_dir.as_posix()}")

        instruction_path = agent_dir / "instruction.txt"
        local_instruction_path = self.logs_dir / "instruction.txt"
        local_instruction_path.write_text(instruction, encoding="utf-8")
        await environment.upload_file(local_instruction_path, instruction_path.as_posix())

        if self._host_side_llm_enabled():
            await self._run_host_cell(environment, local_instruction_path)
        else:
            run_cell_path = self._run_cell_path()
            env = self._cell_env(instruction_path)
            run_log_path = agent_dir / self._RUN_LOG_FILENAME
            shell_script = (
                "set -o pipefail; "
                f"node {shlex.quote(run_cell_path)} "
                f"2>&1 | tee {shlex.quote(run_log_path.as_posix())}"
            )
            command = f"bash -lc {shlex.quote(shell_script)}"
            # _cell_env sets no MAKA_CELL_SOFT_TIMEOUT_MS, so this cell never
            # stops early to settle: it calls the model until it is killed. The
            # model budget is therefore the whole deadline, with no window to add.
            await self.exec_as_agent(environment, command=command, env=env, timeout_sec=self._cell_timeout_sec())
            await self._download_cell_output(environment)
        output = self._read_cell_output(required=True)
        await self._download_runtime_artifacts(environment)
        self._apply_cell_output(context, output)

    def populate_context_post_run(self, context: AgentContext) -> None:
        self._apply_cell_output(context)

    def _run_cell_path(self) -> str:
        maka_repo = self._resolved_flags.get("maka_repo", "/opt/maka-agent")
        return (Path(maka_repo) / "packages" / "headless" / "harbor" / "run-cell.mjs").as_posix()

    def _run_host_cell_path(self) -> str:
        maka_repo = self._get_env("MAKA_HOST_REPO_ROOT") or os.getcwd()
        return (Path(maka_repo) / "packages" / "headless" / "harbor" / "run-host-cell.mjs").as_posix()

    def _host_repo_root(self) -> Path:
        override = self._get_env("MAKA_HOST_REPO_ROOT") or self._get_env("MAKA_REPO_DIR")
        return Path(override) if override else _REPO_ROOT_DEFAULT

    def _headless_cli_path(self) -> Path:
        return self._host_repo_root() / "packages" / "headless" / "dist" / "cli.js"

    _DEFAULT_CELL_TIMEOUT_SEC = 900
    _DEFAULT_CELL_SETTLEMENT_GRACE_SEC = 30

    def _cell_timeout_sec(self, env: dict[str, str] | None = None) -> int:
        """Wall-clock budget for the in-container cell. A hard-coded value turns
        slow-but-healthy tasks into infra failures, so the operator can raise it
        via MAKA_CELL_TIMEOUT_SEC; a malformed value falls back to the default.

        Accepted syntax is an ASCII decimal positive integer literal (no sign,
        no leading zero, no exponent/decimal form, no Unicode digits), and the
        value is capped at 2^53 - 1 (JS Number.MAX_SAFE_INTEGER). This matches
        the TS host's lenientPositiveIntEnv so both sides agree on exactly which
        strings are valid: "1e3", "1.0", "+1800", "01800", "1٢", and over-long
        digit strings all fall back to the default.
        """
        raw = (
            env.get("MAKA_CELL_TIMEOUT_SEC")
            if env is not None
            else self._get_env("MAKA_CELL_TIMEOUT_SEC")
        )
        return _positive_int_literal(raw) or self._DEFAULT_CELL_TIMEOUT_SEC

    def _cell_settlement_grace_sec(self, env: dict[str, str] | None = None) -> int:
        raw = (
            env.get("MAKA_CELL_SETTLEMENT_GRACE_SEC")
            if env is not None
            else self._get_env("MAKA_CELL_SETTLEMENT_GRACE_SEC")
        )
        # Same accepted syntax as MAKA_CELL_TIMEOUT_SEC so both sides of the
        # boundary reject exactly the same strings; bare int() would take
        # "+60"/"060"/" 60 ", which the TypeScript producer never emits.
        return _positive_int_literal(raw) or self._DEFAULT_CELL_SETTLEMENT_GRACE_SEC

    def _model_budget_ms(self, env: dict[str, str] | None = None) -> int:
        """Wall-clock the cell may spend calling the model, in milliseconds.

        This is MAKA_CELL_TIMEOUT_SEC verbatim: the budget is the model budget on
        every path, and the settlement window is added around it rather than
        carved out of it. Benchmark arms are only comparable when this number is
        the task-native budget for every harness.
        """
        budget_ms = self._cell_timeout_sec(env) * 1000
        if budget_ms > _MAX_NODE_TIMER_MS:
            raise RuntimeError(
                "MAKA_CELL_TIMEOUT_SEC exceeds the Node timer limit "
                f"of {_MAX_NODE_TIMER_MS}ms"
            )
        return budget_ms

    def _agent_phase_timeout_sec(self, env: dict[str, str] | None = None) -> int:
        """Wall-clock the whole agent phase may take: the model budget plus the
        window the cell needs to settle its artifacts after it stops calling the
        model. Every hard process deadline uses this, never the model budget, or
        the cell would be killed exactly when it starts writing."""
        return self._cell_timeout_sec(env) + self._cell_settlement_grace_sec(env)

    def _host_side_llm_enabled(self) -> bool:
        return bool(
            self._get_env("MAKA_HOST_API_KEY_FILE")
            or self._get_env("MAKA_HOST_API_KEY")
            or self._get_env("MAKA_HOST_NO_AUTH") == "true"
        )

    def _harbor_backend(self) -> str:
        backend = self._resolved_flags.get("backend", "") or self._get_env("MAKA_BACKEND") or "ai-sdk"
        if backend not in ("ai-sdk", "fake"):
            raise RuntimeError(f"backend={backend} is not supported by Maka Harbor v1; use backend=ai-sdk or backend=fake")
        return backend

    async def _run_host_cell(self, environment: BaseEnvironment, local_instruction_path: Path) -> None:
        container_cwd = await self._container_cwd(environment)
        async with _ToolExecutorServer(self, environment) as executor:
            env = self._host_cell_env(local_instruction_path, container_cwd, executor)
            run_log_path = self.logs_dir / self._RUN_LOG_FILENAME
            process = await asyncio.create_subprocess_exec(
                "node",
                self._run_host_cell_path(),
                cwd=self._get_env("MAKA_HOST_REPO_ROOT") or os.getcwd(),
                env=_host_node_process_env(env),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            try:
                stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=self._agent_phase_timeout_sec())
            except BaseException as error:
                if process.returncode is None:
                    process.kill()
                stdout, stderr = await process.communicate()
                run_log_path.write_bytes(stdout + stderr)
                if isinstance(error, asyncio.TimeoutError):
                    raise RuntimeError(f"Maka host cell exceeded {self._agent_phase_timeout_sec()}s") from error
                raise
            run_log_path.write_bytes(stdout + stderr)
            if process.returncode == 124:
                # run-host-cell uses 124 only after it has settled the runtime at
                # the soft deadline and persisted maka-cell-output.json. Stop only
                # commands that are still active: completed commands may have
                # intentionally left verifier-visible services running.
                executor.mark_reclaim_active_commands()
                return
            if process.returncode != 0:
                message = (stderr or stdout).decode("utf-8", errors="replace").strip()
                raise RuntimeError(f"Maka host cell exited {process.returncode}: {message}")

    async def _container_cwd(self, environment: BaseEnvironment) -> str:
        result = await self.exec_as_agent(environment, command="pwd")
        cwd = _exec_stdout(result).strip()
        return cwd or "."

    def _host_cell_env(self, local_instruction_path: Path, container_cwd: str, executor: "_ToolExecutorServer") -> dict[str, str]:
        env = self._cell_env(Path("/logs/agent/instruction.txt"))
        env["MAKA_INSTRUCTION_FILE"] = str(local_instruction_path)
        env["MAKA_OUTPUT_DIR"] = str(self.logs_dir)
        env["MAKA_STORAGE_ROOT"] = str(self.logs_dir / "maka-storage")
        env["MAKA_WORKDIR"] = container_cwd
        env["MAKA_HARBOR_TOOL_EXECUTOR_URL"] = executor.url
        env["MAKA_HARBOR_TOOL_EXECUTOR_TOKEN"] = executor.token
        env["MAKA_CELL_SOFT_TIMEOUT_MS"] = str(self._model_budget_ms())
        for key in _HOST_PROVIDER_AUTHORITY_ENV_KEYS:
            value = self._get_env(key)
            if value:
                env[key] = value
        return env

    def _cell_env(self, instruction_path: Any) -> dict[str, str]:
        system_prompt = self._resolved_flags.get("system_prompt") or self._get_env("MAKA_SYSTEM_PROMPT")
        model = self.model_name or self._get_env("MAKA_MODEL") or "deepseek/deepseek-v4-flash"
        backend = self._harbor_backend()
        provider = self._resolved_flags.get("provider", "") or self._get_env("MAKA_PROVIDER") or ""
        economy_task_flag = self._resolved_flags.get("economy_task_mode")
        economy_task_env = self._get_env("MAKA_ECONOMY_TASK_MODE")
        economy_task_mode = True if economy_task_flag is True else economy_task_env == "true"
        has_container_proxy = bool(
            self._task_run_in_container()
            and self._get_env("MAKA_PROVIDER_PROXY_URL")
            and self._get_env("MAKA_PROVIDER_PROXY_TOKEN")
        )
        if backend == "ai-sdk" and not self._host_side_llm_enabled() and not has_container_proxy:
            raise RuntimeError("backend=ai-sdk requires host-side provider configuration")
        env = {
            "MAKA_BACKEND": backend,
            "MAKA_MODEL": model,
            "MAKA_INSTRUCTION_FILE": instruction_path.as_posix(),
            "MAKA_OUTPUT_DIR": EnvironmentPaths.agent_dir.as_posix(),
            "MAKA_STORAGE_ROOT": (EnvironmentPaths.agent_dir / "maka-storage").as_posix(),
            "MAKA_ECONOMY_TASK_MODE": "true" if economy_task_mode else "false",
        }
        if system_prompt is not None:
            env["MAKA_SYSTEM_PROMPT"] = system_prompt
        if provider:
            env["MAKA_PROVIDER"] = provider
        for key in (
            # Forward trial pricing so the in-container cell prices unknown models
            # (e.g. deepseek-v4-flash) the same way trial_pricing.py prices the trial;
            # otherwise the cell emits costUsd=0 and the controller flags every task.
            "MAKA_TRIAL_INPUT_USD_PER_1M",
            "MAKA_TRIAL_OUTPUT_USD_PER_1M",
            "MAKA_TRIAL_CACHE_READ_USD_PER_1M",
            "MAKA_TRIAL_CACHE_WRITE_USD_PER_1M",
            "MAKA_TRIAL_PRICING_SOURCE",
            "MAKA_REASONING_EFFORT",
            "MAKA_AGENT_TOOLS",
            "MAKA_MODEL_API_PROTOCOL",
            # Default per-command timeout floor for the in-container Bash tool, so
            # long builds/tests do not hit a hard-coded 2-minute ceiling.
            "MAKA_CELL_COMMAND_TIMEOUT_MS",
            # Harbor owns the benchmark hard deadline. Forward its matching model
            # stream watchdogs so max-reasoning first events are not cut off by the
            # runtime's shorter interactive defaults.
            "MAKA_STREAM_CONNECT_TIMEOUT_MS",
            "MAKA_STREAM_IDLE_TIMEOUT_MS",
            # Benchmark-safe deterministic continuation. These are consumed by
            # run-host-cell.mjs/run-cell.mjs, not by the provider backend.
            "MAKA_HARBOR_CONTINUATION",
            "MAKA_HARBOR_CONTINUATION_MAX_TURNS",
            "MAKA_HARBOR_CONTINUATION_MAX_TOTAL_RUNTIME_STEPS",
            "MAKA_HARBOR_CONTINUATION_PROMPT",
        ):
            value = self._get_env(key)
            if value:
                env[key] = value
        for key, value in os.environ.items():
            if key.startswith("MAKA_CONTEXT_"):
                env[key] = value
        for key, value in getattr(self, "_extra_env", {}).items():
            if key.startswith("MAKA_CONTEXT_") and value is not None:
                env[key] = value
        return env

    async def _download_cell_output(self, environment: BaseEnvironment) -> None:
        remote = EnvironmentPaths.agent_dir / self._CELL_OUTPUT_FILENAME
        local = self.logs_dir / self._CELL_OUTPUT_FILENAME
        try:
            await environment.download_file(remote.as_posix(), local)
        except Exception as exc:  # noqa: BLE001 - best-effort metadata hydration.
            self.logger.debug("Could not download Maka cell output %s: %s", remote, exc)
        # The cell output's runtimeEventsPath/traceEventsPath contracts point at
        # these files. Under Harbor the agent log dir is bind-mounted, so they
        # are already host-side and are skipped; under Pier a --mounts-json run
        # replaces the default log mounts, so without this download the paths
        # would dangle on the host.
        for filename in (self._RUNTIME_EVENTS_FILENAME, self._TRACE_EVENTS_FILENAME):
            events_remote = EnvironmentPaths.agent_dir / filename
            events_local = self.logs_dir / filename
            if events_local.exists():
                continue
            try:
                await environment.download_file(events_remote.as_posix(), events_local)
            except Exception as exc:  # noqa: BLE001 - best-effort metadata hydration.
                self.logger.debug("Could not download Maka agent log %s: %s", events_remote, exc)

    def _read_cell_output(self, *, required: bool) -> dict[str, Any] | None:
        output_path = self.logs_dir / self._CELL_OUTPUT_FILENAME
        if not output_path.exists():
            if required:
                raise RuntimeError(f"Maka cell did not write {self._CELL_OUTPUT_FILENAME}")
            return None
        try:
            output = json.loads(output_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            if required:
                raise RuntimeError(f"Maka cell output is not valid JSON: {output_path}") from exc
            self.logger.debug("Could not read Maka cell output %s: %s", output_path, exc)
            return None
        if not isinstance(output, dict):
            if required:
                raise RuntimeError(f"Maka cell output must be a JSON object: {output_path}")
            self.logger.debug("Maka cell output %s was not a JSON object", output_path)
            return None
        deadline_settlement = output.get("deadlineSettlement")
        if (
            not isinstance(output.get("tokenSummary"), dict)
            and isinstance(deadline_settlement, dict)
            and deadline_settlement.get("source") == "benchmark.deadline"
        ):
            checkpoint_path = self.logs_dir / self._CELL_USAGE_CHECKPOINT_FILENAME
            try:
                checkpoint = json.loads(checkpoint_path.read_text(encoding="utf-8"))
                if isinstance(checkpoint, dict):
                    output["tokenSummary"] = checkpoint
                    output_path.write_text(f"{json.dumps(output, indent=2)}\n", encoding="utf-8")
            except (OSError, json.JSONDecodeError) as exc:
                self.logger.debug("Could not hydrate Maka deadline usage from %s: %s", checkpoint_path, exc)
        return output

    def _apply_cell_output(self, context: AgentContext, output: dict[str, Any] | None = None) -> None:
        if output is None:
            output = self._read_cell_output(required=False)
        if output is None:
            return

        token_summary = output.get("tokenSummary")
        if isinstance(token_summary, dict):
            _apply_trial_pricing(self, token_summary)
            context.n_input_tokens = int(token_summary.get("input") or 0)
            context.n_output_tokens = int(token_summary.get("output") or 0)
            context.n_cache_tokens = int(
                token_summary.get("cachedInput")
                or token_summary.get("cacheHitInput")
                or 0
            )
            context.cost_usd = float(token_summary.get("costUsd") or 0)

        context.metadata = {
            **(context.metadata or {}),
            "maka_status": output.get("status"),
            "maka_error_class": output.get("errorClass"),
            "maka_prompt_hash": output.get("promptHash"),
            "maka_cell_output": str(self.logs_dir / self._CELL_OUTPUT_FILENAME),
            "maka_runtime_events": output.get("runtimeEventsPath"),
            "maka_cached_input_tokens": _optional_int(token_summary, "cachedInput"),
            "maka_cache_hit_input_tokens": _optional_int(token_summary, "cacheHitInput"),
            "maka_cache_miss_input_tokens": _optional_int(token_summary, "cacheMissInput"),
            "maka_cache_write_input_tokens": _optional_int(token_summary, "cacheWriteInput"),
            "maka_estimated_cost_usd": _optional_float(token_summary, "costUsd"),
            "maka_pricing_source": token_summary.get("pricingSource") if isinstance(token_summary, dict) else None,
            "maka_provider_visible_tool_count": _optional_int(output.get("toolSummary"), "providerVisibleToolCount"),
            "maka_actual_tool_calls": _optional_int(output.get("toolSummary"), "actualToolCalls"),
            "maka_actual_tool_names": _optional_string_list(output.get("toolSummary"), "actualToolNames"),
            "maka_actual_tool_call_counts": _optional_dict(output.get("toolSummary"), "actualToolCallCounts"),
        }
        self._write_trajectory(output)

    def _resolve_runtime_events_path(self) -> Path | None:
        local = self.logs_dir / self._RUNTIME_EVENTS_FILENAME
        return local if local.is_file() else None

    async def _download_runtime_artifacts(self, environment: BaseEnvironment) -> None:
        runtime_events_path = self._resolve_runtime_events_path()
        if runtime_events_path is None:
            return
        local_store_root = self._trajectory_artifact_store_root()
        local_artifact_root = local_store_root / "artifacts"
        database_path = local_store_root / "runtime.sqlite"
        if database_path.is_file():
            return
        shutil.rmtree(local_store_root, ignore_errors=True)
        remote_store_root = EnvironmentPaths.agent_dir / "trajectory-state"
        remote_artifact_root = remote_store_root / "artifacts"
        try:
            database_path.parent.mkdir(parents=True, exist_ok=True)
            await environment.download_file(
                (remote_store_root / "runtime.sqlite").as_posix(), database_path
            )
            for relative_path in referenced_image_artifact_paths(
                runtime_events_path, local_store_root
            ):
                local = local_artifact_root / relative_path
                local.parent.mkdir(parents=True, exist_ok=True)
                await environment.download_file(
                    (remote_artifact_root / relative_path).as_posix(), local
                )
        except Exception as exc:  # noqa: BLE001 - trajectory builder fails closed.
            shutil.rmtree(local_store_root, ignore_errors=True)
            self.logger.debug("Could not download Maka runtime artifacts: %s", exc)

    def _write_trajectory(self, output: dict[str, Any]) -> None:
        token_summary = output.get("tokenSummary")
        tool_summary = output.get("toolSummary")
        output_status = output.get("status") if isinstance(output.get("status"), str) else None
        runtime_refs = output.get("runtimeRefs")
        if not isinstance(runtime_refs, dict):
            runtime_refs = None
        evidence = load_runtime_trajectory(
            self._resolve_runtime_events_path(),
            output_status,
            runtime_refs,
            self._trajectory_artifact_store_root(),
            self.logs_dir,
        )
        steps = [Step(**step) for step in evidence.steps]
        final_metrics = FinalMetrics(
            total_prompt_tokens=_optional_int(token_summary, "input"),
            total_completion_tokens=_optional_int(token_summary, "output"),
            total_cached_tokens=_optional_int(token_summary, "cachedInput"),
            total_cost_usd=_optional_float(token_summary, "costUsd"),
            total_steps=len(steps),
            extra=redact_value({
                "maka_status": output.get("status"),
                "maka_error_class": output.get("errorClass"),
                "maka_prompt_hash": output.get("promptHash"),
                "runtime_events_path": output.get("runtimeEventsPath"),
                "runtime_event_count": evidence.runtime_event_count,
                "reported_runtime_steps": output.get("steps") if isinstance(output.get("steps"), int) else None,
                "cached_input_tokens": _optional_int(token_summary, "cachedInput"),
                "cache_hit_input_tokens": _optional_int(token_summary, "cacheHitInput"),
                "cache_miss_input_tokens": _optional_int(token_summary, "cacheMissInput"),
                "cache_write_input_tokens": _optional_int(token_summary, "cacheWriteInput"),
                "estimated_cost_usd": _optional_float(token_summary, "costUsd"),
                "pricing_source": token_summary.get("pricingSource") if isinstance(token_summary, dict) else None,
                "provider_visible_tool_count": _optional_int(tool_summary, "providerVisibleToolCount"),
                "actual_tool_calls": _optional_int(tool_summary, "actualToolCalls"),
                "actual_tool_names": _optional_string_list(tool_summary, "actualToolNames"),
                "actual_tool_call_counts": _optional_dict(tool_summary, "actualToolCallCounts"),
            }),
        )
        notes = (
            f"Complete Maka trajectory derived from {evidence.runtime_event_count} immutable RuntimeEvents."
            if evidence.artifact_kind == "full"
            else f"Summary artifact only; complete RuntimeEvent trajectory unavailable: {evidence.reason}."
        )
        session_id = (
            runtime_refs.get("sessionId")
            if isinstance(runtime_refs, dict) and isinstance(runtime_refs.get("sessionId"), str)
            else None
        )
        trajectory = Trajectory(
            session_id=session_id,
            agent=Agent(name="maka", version=self.version() or "unknown", model_name=self.model_name),
            steps=steps,
            notes=notes,
            final_metrics=final_metrics,
            extra={
                "maka_artifact_kind": evidence.artifact_kind,
                "maka_terminal_status": evidence.terminal_status,
                **({"maka_summary_reason": evidence.reason} if evidence.reason else {}),
            },
        )
        trajectory_path = self.logs_dir / "trajectory.json"
        try:
            trajectory_path.write_text(format_trajectory_json(trajectory.to_json_dict()), encoding="utf-8")
        except OSError as exc:
            self.logger.debug("Could not write Maka trajectory %s: %s", trajectory_path, exc)

    async def _run_task_run_container(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
        *,
        phase_started_monotonic: float,
        model_deadline_at_ms: int | None,
    ) -> None:
        """Run the full task-run controller inside Pier's task container."""
        self.logs_dir.mkdir(parents=True, exist_ok=True)
        agent_dir = EnvironmentPaths.agent_dir
        await self.exec_as_agent(environment, command=f"mkdir -p {agent_dir.as_posix()}")
        instruction_path = agent_dir / "instruction.txt"
        local_instruction_path = self.logs_dir / "instruction.txt"
        local_instruction_path.write_text(instruction, encoding="utf-8")
        await environment.upload_file(local_instruction_path, instruction_path.as_posix())

        task_workdir = (
            str(getattr(getattr(environment, "task_env_config", None), "workdir", "") or ".")
        )
        out_dir = agent_dir / "maka-task-run"
        env = self._container_task_run_env(
            instruction_path,
            out_dir,
            model_deadline_at_ms=model_deadline_at_ms,
        )
        command = _headless_harbor_command(
            cli_path=_CONTAINER_HEADLESS_CLI,
            instruction_path=instruction_path,
            task_workdir=task_workdir,
            task_id=str(
                getattr(environment, "session_id", None)
                or self._get_env("MAKA_TASK_ID")
                or "terminal-bench-task"
            ),
            out_dir=out_dir,
            env=env,
            node_path=_MAKA_NODE_TOOLCHAIN_NODE,
            isolation="harbor-local",
        )
        stdout_path = agent_dir / "maka-harbor.stdout.json"
        stderr_path = agent_dir / "maka-harbor.stderr.log"
        shell_script = (
            f"{shlex.join(str(part) for part in command)} "
            f"> {shlex.quote(stdout_path.as_posix())} "
            f"2> {shlex.quote(stderr_path.as_posix())}; "
            "status=$?; "
            'if [ "$status" -eq 124 ]; then exit 0; fi; '
            'exit "$status"'
        )
        try:
            await self.exec_as_agent(
                environment,
                command=f"bash -lc {shlex.quote(shell_script)}",
                env=env,
                timeout_sec=self._task_run_hard_timeout_sec(env, phase_started_monotonic),
            )
        finally:
            await self._download_task_run_artifacts(environment)

        output = self._read_cell_output(required=True)
        self._apply_cell_output(context, output)

    def _container_task_run_env(
        self,
        instruction_path: Path,
        out_dir: Path,
        *,
        model_deadline_at_ms: int | None,
    ) -> dict[str, str]:
        env = {
            key: value
            for key, value in (getattr(self, "_extra_env", {}) or {}).items()
            if key.startswith("MAKA_") and value is not None
        }
        env.update(self._cell_env(instruction_path))
        _normalize_cli_env(env)
        env["MAKA_REPO_DIR"] = str(_CONTAINER_MAKA_REPO)
        env["MAKA_TASK_RUN_OUT_DIR"] = str(out_dir)
        env["MAKA_OUTPUT_DIR"] = str(out_dir)
        env["MAKA_STORAGE_ROOT"] = str(out_dir / "runs")
        env["MAKA_CELL_ARTIFACT_DIR"] = EnvironmentPaths.agent_dir.as_posix()
        if model_deadline_at_ms is None:
            env["MAKA_CELL_SOFT_TIMEOUT_MS"] = str(self._model_budget_ms(env))
        else:
            env.pop("MAKA_CELL_SOFT_TIMEOUT_MS", None)
            env["MAKA_CELL_DEADLINE_AT_MS"] = str(model_deadline_at_ms)

        proxy_url = self._get_env("MAKA_PROVIDER_PROXY_URL")
        proxy_token = self._get_env("MAKA_PROVIDER_PROXY_TOKEN")
        env.pop("MAKA_PROVIDER_PROXY_URL", None)
        env.pop("MAKA_PROVIDER_PROXY_TOKEN", None)
        if self._harbor_backend() != "fake":
            if not proxy_url or not proxy_token:
                raise RuntimeError("Maka container task-run requires the host provider proxy")
            env["MAKA_HOST_BASE_URL"] = proxy_url
            env["MAKA_HOST_API_KEY"] = proxy_token
            env["NODE_USE_ENV_PROXY"] = "1"
        return env

    def _task_run_hard_timeout_sec(
        self,
        env: dict[str, str],
        phase_started_monotonic: float,
    ) -> float:
        phase_timeout_sec = _positive_int_literal(env.get("MAKA_AGENT_PHASE_TIMEOUT_SEC"))
        if phase_timeout_sec is None:
            return float(self._agent_phase_timeout_sec(env))
        remaining = phase_timeout_sec - max(0.0, time.monotonic() - phase_started_monotonic)
        if remaining <= 0:
            raise asyncio.TimeoutError("Maka agent phase exhausted before task-run start")
        return remaining

    async def _download_task_run_artifacts(self, environment: BaseEnvironment) -> None:
        await self._download_cell_output(environment)
        remote_dir = EnvironmentPaths.agent_dir / "maka-task-run"
        local_dir = self.logs_dir / "maka-task-run"
        try:
            await environment.download_dir(remote_dir.as_posix(), local_dir)
        except Exception as exc:  # noqa: BLE001 - best-effort artifact hydration.
            self.logger.debug("Could not download Maka task-run artifacts %s: %s", remote_dir, exc)
        for filename in (
            self._CELL_USAGE_CHECKPOINT_FILENAME,
            self._CELL_EXECUTION_IDENTITY_FILENAME,
            "maka-harbor.stdout.json",
            "maka-harbor.stderr.log",
        ):
            remote = EnvironmentPaths.agent_dir / filename
            local = self.logs_dir / filename
            if local.exists():
                continue
            try:
                await environment.download_file(remote.as_posix(), local)
            except Exception as exc:  # noqa: BLE001 - best-effort artifact hydration.
                self.logger.debug("Could not download Maka task-run artifact %s: %s", remote, exc)
    def _trajectory_artifact_store_root(self) -> Path:
        configured = getattr(self, "_trajectory_storage_root", None)
        if isinstance(configured, Path):
            return configured
        if self._harbor_mode() == "task-run":
            return self.logs_dir / "maka-task-run" / "trajectory-state"
        return self.logs_dir / "maka-storage"

    async def _run_task_run_host(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        """Run the full task-run controller on the host, bridging tool execution
        into the task container."""
        self.logs_dir.mkdir(parents=True, exist_ok=True)

        env = os.environ.copy()
        env.update(_load_env_file(_DEFAULT_RUNNER_ENV))
        env.update(getattr(self, "_extra_env", {}) or {})
        _normalize_cli_env(env)
        host_repo_root = self._host_repo_root()
        if not host_repo_root.is_absolute():
            host_repo_root = Path(os.path.abspath(host_repo_root))
        env.setdefault("MAKA_REPO_DIR", str(host_repo_root))
        env.setdefault("MAKA_MODEL", "deepseek-chat")
        env.setdefault("MAKA_TASK_RUN_OUT_DIR", str(self.logs_dir / "maka-task-run"))
        env.setdefault("MAKA_CELL_ARTIFACT_DIR", str(self.logs_dir))
        task_run_out_dir = Path(env["MAKA_TASK_RUN_OUT_DIR"])
        if not task_run_out_dir.is_absolute():
            task_run_out_dir = host_repo_root / task_run_out_dir
        env["MAKA_TASK_RUN_OUT_DIR"] = str(task_run_out_dir)
        env.setdefault("MAKA_OUTPUT_DIR", str(task_run_out_dir))
        env.setdefault("MAKA_STORAGE_ROOT", str(task_run_out_dir / "runs"))
        output_dir = Path(env["MAKA_OUTPUT_DIR"])
        storage_root = Path(env["MAKA_STORAGE_ROOT"])
        if not output_dir.is_absolute():
            output_dir = host_repo_root / output_dir
        if not storage_root.is_absolute():
            storage_root = host_repo_root / storage_root
        env["MAKA_OUTPUT_DIR"] = str(output_dir)
        env["MAKA_STORAGE_ROOT"] = str(storage_root)
        self._trajectory_storage_root = output_dir / "trajectory-state"
        env["MAKA_CELL_SOFT_TIMEOUT_MS"] = str(self._model_budget_ms(env))

        task_workdir, workdir_probe = await self._resolve_task_workdir(environment)

        stdout_path = self.logs_dir / "maka-harbor.stdout.json"
        stderr_path = self.logs_dir / "maka-harbor.stderr.log"
        status_path = self.logs_dir / "maka-harbor.status.json"
        instruction_path = self.logs_dir / "instruction.txt"
        started_at = _utc_now()
        task_run_out_dir.mkdir(parents=True, exist_ok=True)
        instruction_path.write_text(instruction, encoding="utf-8")
        stdout_path.write_bytes(b"")
        stderr_path.write_bytes(b"")
        self._write_status(
            status_path,
            {
                "status": "starting",
                "startedAt": started_at,
                "stdoutLog": str(stdout_path),
                "stderrLog": str(stderr_path),
                "taskRunOutDir": str(task_run_out_dir),
                "resolvedCwd": task_workdir,
                "workdirProbe": workdir_probe,
                "runnerEnv": _runner_env_summary(env),
            },
        )

        timeout_sec = self._agent_phase_timeout_sec(env)
        proc: asyncio.subprocess.Process | None = None
        async with _ToolExecutorServer(self, environment) as executor:
            env["MAKA_HARBOR_TOOL_EXECUTOR_URL"] = executor.url
            env["MAKA_HARBOR_TOOL_EXECUTOR_TOKEN"] = executor.token
            command = _headless_harbor_command(
                cli_path=self._headless_cli_path(),
                instruction_path=instruction_path,
                task_workdir=task_workdir,
                task_id=str(getattr(environment, "session_id", None) or env.get("MAKA_TASK_ID") or "terminal-bench-task"),
                out_dir=task_run_out_dir,
                env=env,
            )
            try:
                proc = await asyncio.create_subprocess_exec(
                    *command,
                    cwd=str(host_repo_root),
                    stdin=asyncio.subprocess.PIPE,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                    env=env,
                )
                self._write_status(
                    status_path,
                    {
                        "status": "running",
                        "startedAt": started_at,
                        "updatedAt": _utc_now(),
                        "runnerPid": proc.pid,
                        "timeoutSec": timeout_sec,
                        "stdoutLog": str(stdout_path),
                        "stderrLog": str(stderr_path),
                        "taskRunOutDir": str(task_run_out_dir),
                        "resolvedCwd": task_workdir,
                        "workdirProbe": workdir_probe,
                        "runnerEnv": _runner_env_summary(env),
                        "command": _redacted_command(command),
                    },
                )
                stdout, stderr = await self._communicate_streaming(
                    proc=proc,
                    stdin_payload=b"",
                    stdout_path=stdout_path,
                    stderr_path=stderr_path,
                    timeout_sec=timeout_sec,
                )
            except asyncio.TimeoutError:
                self._write_status(
                    status_path,
                    {
                        "status": "timeout",
                        "startedAt": started_at,
                        "finishedAt": _utc_now(),
                        "runnerPid": proc.pid if proc else None,
                        "returnCode": proc.returncode if proc else None,
                        "timeoutSec": timeout_sec,
                        "stdoutLog": str(stdout_path),
                        "stderrLog": str(stderr_path),
                        "taskRunOutDir": str(task_run_out_dir),
                        "resolvedCwd": task_workdir,
                        "workdirProbe": workdir_probe,
                        "runnerEnv": _runner_env_summary(env),
                        "command": _redacted_command(command),
                    },
                )
                raise
            except Exception as exc:
                self._write_status(
                    status_path,
                    {
                        "status": "failed",
                        "startedAt": started_at,
                        "finishedAt": _utc_now(),
                        "runnerPid": proc.pid if proc else None,
                        "returnCode": proc.returncode if proc else None,
                        "error": str(exc),
                        "stdoutLog": str(stdout_path),
                        "stderrLog": str(stderr_path),
                        "taskRunOutDir": str(task_run_out_dir),
                        "resolvedCwd": task_workdir,
                        "workdirProbe": workdir_probe,
                        "runnerEnv": _runner_env_summary(env),
                        "command": _redacted_command(command),
                    },
                )
                raise

            if proc is not None and proc.returncode == 124:
                # The benchmark deadline is an expected scored terminal state.
                # Reclaim only in-flight commands while preserving services from
                # completed commands for the post-exit verifier.
                executor.mark_reclaim_active_commands()
            elif proc is not None and proc.returncode != 0:
                # Other non-zero exits are infrastructure failures, so no scoped
                # background work should survive into grading or later attempts.
                executor.mark_reclaim_scoped_processes()

        parsed = self._parse_node_result(stdout)
        assert proc is not None
        self._write_status(
            status_path,
            {
                "status": (
                    "completed"
                    if proc.returncode == 0
                    else "budget_exhausted"
                    if proc.returncode == 124
                    else "failed"
                ),
                "startedAt": started_at,
                "finishedAt": _utc_now(),
                "runnerPid": proc.pid,
                "returnCode": proc.returncode,
                "parsedStatus": parsed.get("status"),
                "benchmarkFailureKind": parsed.get("benchmarkFailureKind"),
                "benchmarkFailureShouldThrow": parsed.get("benchmarkFailureShouldThrow"),
                "stdoutBytes": len(stdout),
                "stderrBytes": len(stderr),
                "stdoutLog": str(stdout_path),
                "stderrLog": str(stderr_path),
                "taskRunOutDir": str(task_run_out_dir),
                "resolvedCwd": task_workdir,
                "workdirProbe": workdir_probe,
                "runnerEnv": _runner_env_summary(env),
                "command": _redacted_command(command),
            },
        )
        context.metadata = {
            **(context.metadata or {}),
            "maka_harbor": {
                "return_code": proc.returncode,
                "stdout_log": str(stdout_path),
                "stderr_log": str(stderr_path),
                "status": parsed.get("status"),
                "model": parsed.get("model"),
                "max_steps": parsed.get("maxSteps"),
                "autonomous": parsed.get("autonomous"),
                "autonomous_max_attempts": parsed.get("autonomousMaxAttempts"),
                "autonomous_max_runtime_steps": parsed.get("autonomousMaxRuntimeSteps"),
                "autonomous_max_wall_time_ms": parsed.get("autonomousMaxWallTimeMs"),
                "event_count": parsed.get("eventCount"),
                "message_count": parsed.get("messageCount"),
                "llm_call_count": parsed.get("llmCallCount"),
                "tool_call_count": parsed.get("toolCallCount"),
                "error": parsed.get("error"),
                "benchmark_failure_kind": parsed.get("benchmarkFailureKind"),
                "benchmark_failure_should_throw": parsed.get("benchmarkFailureShouldThrow"),
                "task_run": parsed.get("taskRun") or _task_run_summary(parsed),
                "resolved_cwd": task_workdir,
                "workdir_probe": workdir_probe,
            },
        }
        usage = parsed.get("tokenUsage") if isinstance(parsed, dict) else None
        if isinstance(usage, dict):
            context.n_input_tokens = _int_or_none(usage.get("input"))
            context.n_cache_tokens = _int_or_none(usage.get("cacheHitInput"))
            context.n_output_tokens = _int_or_none(usage.get("output"))

        if proc.returncode != 0 and not (
            proc.returncode == 124 and parsed.get("settledByDeadline") is True
        ):
            raise RuntimeError(f"Maka Harbor task-run failed; see {stderr_path}")

    async def _resolve_task_workdir(
        self,
        environment: BaseEnvironment,
    ) -> tuple[str, list[dict[str, Any]]]:
        configured = getattr(getattr(environment, "task_env_config", None), "workdir", None)
        candidates: list[str | None] = []
        if configured:
            candidates.append(str(configured))
        candidates.extend([None, "/app", "/workspace", "/"])

        seen: set[str] = set()
        probes: list[dict[str, Any]] = []
        for candidate in candidates:
            marker = "<default>" if candidate is None else candidate
            if marker in seen:
                continue
            seen.add(marker)
            # Probe with a bare exec: an invalid candidate directory makes `pwd`
            # exit non-zero, and that must skip to the next candidate rather than
            # abort the whole probe (exec_as_agent would raise on the first miss).
            result = await environment.exec(
                command="pwd",
                cwd=candidate,
                timeout_sec=10,
            )
            stdout = _exec_stdout(result).strip()
            stderr = _exec_stderr(result).strip()
            return_code = _exec_exit_code(result)
            probes.append(
                {
                    "candidate": marker,
                    "return_code": return_code,
                    "stdout": stdout,
                    "stderr": stderr,
                }
            )
            if return_code == 0:
                resolved = _last_absolute_path(stdout)
                if resolved:
                    return resolved, probes

        fallback = str(configured or "/")
        probes.append({"fallback": fallback})
        return fallback, probes

    async def _communicate_streaming(
        self,
        *,
        proc: asyncio.subprocess.Process,
        stdin_payload: bytes,
        stdout_path: Path,
        stderr_path: Path,
        timeout_sec: int,
    ) -> tuple[bytes, bytes]:
        stdout_chunks: list[bytes] = []
        stderr_chunks: list[bytes] = []
        stdin_task = asyncio.create_task(self._write_process_stdin(proc, stdin_payload))
        stdout_task = asyncio.create_task(self._tee_stream(proc.stdout, stdout_path, stdout_chunks))
        stderr_task = asyncio.create_task(self._tee_stream(proc.stderr, stderr_path, stderr_chunks))

        try:
            await asyncio.wait_for(proc.wait(), timeout=timeout_sec)
            await asyncio.wait_for(
                asyncio.gather(stdin_task, stdout_task, stderr_task),
                timeout=30,
            )
        except asyncio.TimeoutError:
            with stderr_path.open("ab") as handle:
                marker = {
                    "event": "maka_harbor_timeout",
                    "timeoutSec": timeout_sec,
                    "at": _utc_now(),
                }
                handle.write(("\n" + json.dumps(marker) + "\n").encode("utf-8"))
                handle.flush()
            if proc.returncode is None:
                proc.kill()
                with contextlib.suppress(Exception):
                    await asyncio.wait_for(proc.wait(), timeout=10)
            raise
        finally:
            for task in (stdin_task, stdout_task, stderr_task):
                if not task.done():
                    task.cancel()
            await asyncio.gather(stdin_task, stdout_task, stderr_task, return_exceptions=True)

        return b"".join(stdout_chunks), b"".join(stderr_chunks)

    @staticmethod
    async def _write_process_stdin(
        proc: asyncio.subprocess.Process,
        payload: bytes,
    ) -> None:
        if proc.stdin is None:
            return
        try:
            proc.stdin.write(payload)
            await proc.stdin.drain()
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            with contextlib.suppress(Exception):
                proc.stdin.close()
            with contextlib.suppress(Exception):
                await proc.stdin.wait_closed()

    @staticmethod
    async def _tee_stream(
        reader: asyncio.StreamReader | None,
        path: Path,
        chunks: list[bytes],
    ) -> None:
        if reader is None:
            return
        with path.open("ab") as handle:
            while True:
                chunk = await reader.read(65536)
                if not chunk:
                    break
                chunks.append(chunk)
                handle.write(chunk)
                handle.flush()

    @staticmethod
    def _write_status(path: Path, payload: dict[str, Any]) -> None:
        path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    @staticmethod
    def _parse_node_result(stdout: bytes) -> dict[str, Any]:
        text = stdout.decode("utf-8", errors="replace").strip()
        if not text:
            return {}
        # The runner writes one JSON object to stdout. If a dependency writes
        # noise, use the last JSON-looking line.
        for line in reversed(text.splitlines()):
            line = line.strip()
            if line.startswith("{") and line.endswith("}"):
                return json.loads(line)
        return {}


class _ToolExecutorServer:
    def __init__(self, agent: MakaAgent, environment: BaseEnvironment) -> None:
        self._agent = agent
        self._environment = environment
        self._loop: asyncio.AbstractEventLoop | None = None
        self._server: ThreadingHTTPServer | None = None
        self._thread: threading.Thread | None = None
        self._futures: set[concurrent.futures.Future[Any]] = set()
        self._future_command_ids: dict[concurrent.futures.Future[Any], str] = {}
        self._futures_lock = threading.Lock()
        self._accepting_requests = False
        self._reclaim_scoped_processes = False
        self._reclaim_active_commands = False
        self._command_cleanup_error: BaseException | None = None
        self.token = secrets.token_urlsafe(32)
        self.command_scope = secrets.token_urlsafe(24)
        self.url = ""

    async def __aenter__(self) -> "_ToolExecutorServer":
        self._loop = asyncio.get_running_loop()
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:  # noqa: N802 - stdlib callback name.
                outer._handle_post(self)

            def log_message(self, format: str, *args: Any) -> None:  # noqa: A002 - stdlib callback name.
                return

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        host, port = self._server.server_address
        self.url = f"http://{host}:{port}"
        with self._futures_lock:
            self._accepting_requests = True
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()
        return self

    def mark_reclaim_scoped_processes(self) -> None:
        """Make teardown stop active scoped commands before returning.

        Callers use this after an exception or a non-zero infrastructure exit,
        where scoped background processes must not survive into grading.
        """
        self._reclaim_scoped_processes = True

    def mark_reclaim_active_commands(self) -> None:
        """Stop in-flight commands while preserving completed service processes."""
        self._reclaim_active_commands = True

    async def __aexit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        stop_error: BaseException | None = None
        cleanup_error: BaseException | None = None
        reclaim_scope = exc_type is not None or self._reclaim_scoped_processes
        reclaim_active = self._reclaim_active_commands and not reclaim_scope
        try:
            cleanup_error = await self._stop_server(
                reclaim_scoped_processes=reclaim_scope,
                reclaim_active_commands=reclaim_active,
            )
        except BaseException as error:
            stop_error = error
        if stop_error is not None and not reclaim_scope:
            cleanup_error = await self._cleanup_all_scoped_processes()
        with self._futures_lock:
            command_cleanup_error = self._command_cleanup_error
        if stop_error is not None:
            raise stop_error
        if cleanup_error is not None:
            raise cleanup_error
        if command_cleanup_error is not None:
            raise command_cleanup_error

    async def _stop_server(
        self,
        *,
        reclaim_scoped_processes: bool,
        reclaim_active_commands: bool,
    ) -> BaseException | None:
        with self._futures_lock:
            self._accepting_requests = False
            futures = list(self._futures)
            active_command_ids = [
                self._future_command_ids[future]
                for future in futures
                if not future.done() and future in self._future_command_ids
            ]
        if reclaim_scoped_processes:
            cleanup_error = await self._drain_futures_with_cleanup(futures, None)
        elif reclaim_active_commands:
            cleanup_error = await self._drain_futures_with_cleanup(
                futures, active_command_ids
            )
        else:
            cleanup_error = await self._drain_futures(futures)
        if self._server is not None:
            await asyncio.to_thread(self._server.shutdown)
            await asyncio.to_thread(self._server.server_close)
        if self._thread is not None:
            await asyncio.to_thread(self._thread.join, 5)
        return cleanup_error

    async def _drain_futures(
        self, futures: list[concurrent.futures.Future[Any]]
    ) -> None:
        if futures:
            await asyncio.gather(
                *(asyncio.wrap_future(future) for future in futures),
                return_exceptions=True,
            )

    async def _drain_futures_with_cleanup(
        self,
        futures: list[concurrent.futures.Future[Any]],
        command_ids: list[str] | None,
    ) -> BaseException | None:
        while any(not future.done() for future in futures):
            cleanup_error = await self._cleanup_processes(command_ids)
            if cleanup_error is not None:
                for future in futures:
                    future.cancel()
                await self._drain_futures(futures)
                return cleanup_error
            await asyncio.sleep(0.2)
        await self._drain_futures(futures)
        return await self._cleanup_processes(command_ids)

    async def _cleanup_processes(
        self, command_ids: list[str] | None
    ) -> BaseException | None:
        first_error: BaseException | None = None
        try:
            await self._cleanup_processes_with_signal(command_ids, "TERM")
        except BaseException as error:
            first_error = error
        await asyncio.sleep(0.2)
        try:
            await self._cleanup_processes_with_signal(command_ids, "KILL")
        except BaseException as error:
            if first_error is None:
                first_error = error
        return first_error

    async def _cleanup_all_scoped_processes(self) -> BaseException | None:
        return await self._cleanup_processes(None)

    async def _cleanup_processes_with_signal(
        self, command_ids: list[str] | None, signal: str
    ) -> None:
        command = (
            _scoped_process_cleanup_command(self.command_scope, signal)
            if command_ids is None
            else _scoped_command_cleanup_command(
                self.command_scope, command_ids, signal
            )
        )
        await _exec_cleanup_command(self._agent, self._environment, command)

    def _handle_post(self, handler: BaseHTTPRequestHandler) -> None:
        if handler.path != "/exec":
            _write_http(handler, 404, {"error": "not found"})
            return
        if handler.headers.get("authorization") != f"Bearer {self.token}":
            _write_http(handler, 401, {"error": "unauthorized"})
            return
        command_id: str | None = None
        future: concurrent.futures.Future[Any] | None = None
        try:
            length = int(handler.headers.get("content-length") or "0")
            payload = json.loads(handler.rfile.read(length).decode("utf-8"))
            command = payload.get("command")
            if not isinstance(command, str) or not command:
                raise ValueError("command is required")
            cwd = payload.get("cwd")
            timeout_ms = payload.get("timeoutMs")
            timeout_sec = _timeout_sec(timeout_ms) or _BRIDGE_DEFAULT_TIMEOUT_SEC
            command_id = secrets.token_urlsafe(12)
            assert self._loop is not None
            with self._futures_lock:
                if not self._accepting_requests:
                    raise RuntimeError("tool executor is shutting down")
                # Run the bridged tool command as a bare container exec, not via
                # exec_as_agent: a non-zero exit is a *successful* transport
                # response (the tool ran and reported a failure), and the agent's
                # _extra_env must never leak into the model's command environment.
                future = asyncio.run_coroutine_threadsafe(
                    self._environment.exec(
                        command=_scoped_command(
                            command,
                            self.command_scope,
                            command_id,
                        ),
                        cwd=cwd if isinstance(cwd, str) and cwd else None,
                        timeout_sec=timeout_sec,
                    ),
                    self._loop,
                )
                self._futures.add(future)
                self._future_command_ids[future] = command_id
            future.add_done_callback(self._discard_future)
            result = future.result(timeout=timeout_sec + 30)
            return_code = _exec_exit_code(result)
            _write_http(handler, 200, {
                "exitCode": return_code,
                "returnCode": return_code,
                "stdout": _exec_stdout(result),
                "stderr": _exec_stderr(result),
            })
        except Exception as exc:  # noqa: BLE001 - RPC boundary returns tool failure text.
            cleanup_error: BaseException | None = None
            if command_id is not None and future is not None:
                cleanup_error = self._cleanup_failed_command(command_id)
                if cleanup_error is not None:
                    with self._futures_lock:
                        if self._command_cleanup_error is None:
                            self._command_cleanup_error = cleanup_error
            if isinstance(
                exc, (asyncio.TimeoutError, concurrent.futures.TimeoutError)
            ):
                if cleanup_error is not None:
                    _write_http(handler, 500, {
                        "error": f"timed-out command cleanup failed: {cleanup_error}"
                    })
                else:
                    _write_http(handler, 200, {
                        "exitCode": 124,
                        "returnCode": 124,
                        "stdout": "",
                        "stderr": "",
                        "timedOut": True,
                    })
            else:
                _write_http(handler, 500, {"error": str(exc)})

    def _cleanup_failed_command(self, command_id: str) -> BaseException | None:
        assert self._loop is not None
        cleanup = asyncio.run_coroutine_threadsafe(
            self._cleanup_processes([command_id]),
            self._loop,
        )
        try:
            return cleanup.result(timeout=30)
        except BaseException as error:
            return error

    def _discard_future(self, future: concurrent.futures.Future[Any]) -> None:
        with self._futures_lock:
            self._futures.discard(future)
            self._future_command_ids.pop(future, None)


def _write_http(handler: BaseHTTPRequestHandler, status: int, payload: dict[str, Any]) -> None:
    body = json.dumps(payload).encode("utf-8")
    handler.send_response(status)
    handler.send_header("content-type", "application/json")
    handler.send_header("content-length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def _timeout_sec(value: Any) -> int | None:
    if isinstance(value, (int, float)) and value > 0:
        return max(1, int((value + 999) // 1000))
    return None


def _exec_stdout(result: Any) -> str:
    value = getattr(result, "stdout", "")
    return value if isinstance(value, str) else ""


def _exec_stderr(result: Any) -> str:
    value = getattr(result, "stderr", "")
    return value if isinstance(value, str) else ""


def _exec_exit_code(result: Any) -> int:
    # Harbor 0.13.2 ExecResult exposes the exit status as `return_code`; the
    # other names stay for compatibility with older/stubbed exec results.
    for name in ("return_code", "exit_code", "exitCode", "returncode"):
        value = getattr(result, name, None)
        if isinstance(value, int):
            return value
    return 0


def _optional_int(value: Any, key: str) -> int | None:
    if not isinstance(value, dict):
        return None
    raw = value.get(key)
    return int(raw) if isinstance(raw, (int, float)) and not isinstance(raw, bool) else None


def _optional_float(value: Any, key: str) -> float | None:
    if not isinstance(value, dict):
        return None
    raw = value.get(key)
    return float(raw) if isinstance(raw, (int, float)) and not isinstance(raw, bool) else None


def _optional_string_list(value: Any, key: str) -> list[str] | None:
    if not isinstance(value, dict):
        return None
    raw = value.get(key)
    if not isinstance(raw, list) or not all(isinstance(item, str) for item in raw):
        return None
    return raw


def _optional_dict(value: Any, key: str) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    raw = value.get(key)
    return raw if isinstance(raw, dict) else None


def _apply_trial_pricing(agent: MakaAgent, token_summary: dict[str, Any]) -> None:
    pricing = pricing_from_env(agent._get_env)
    if pricing is None:
        return

    input_tokens = _optional_int(token_summary, "input") or 0
    output_tokens = _optional_int(token_summary, "output") or 0
    cache_read = (
        _optional_int(token_summary, "cachedInput")
        or _optional_int(token_summary, "cacheHitInput")
        or 0
    )
    cache_write = _optional_int(token_summary, "cacheWriteInput") or 0
    cache_miss = _optional_int(token_summary, "cacheMissInput")
    if cache_miss is None:
        cache_miss = max(0, input_tokens - cache_read - cache_write)

    token_summary["costUsd"] = estimate_cost(
        {
            "input": input_tokens,
            "output": output_tokens,
            "cache_read": cache_read,
            "cache_write": cache_write,
            "cache_miss": cache_miss,
        },
        pricing,
    )
    token_summary["pricingSource"] = agent._get_env("MAKA_TRIAL_PRICING_SOURCE") or "env"


# ---------------------------------------------------------------------------
# task-run host mode helpers
# ---------------------------------------------------------------------------


def _load_env_file(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.is_file():
        return values
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key:
            values[key] = value
    return values


def _normalize_cli_env(env: dict[str, str]) -> None:
    provider = env.get("MAKA_PROVIDER") or env.get("MAKA_PROVIDER_TYPE")
    if provider:
        env.setdefault("MAKA_PROVIDER", provider)
    if env.get("MAKA_API_KEY"):
        env.setdefault(
            _provider_api_key_env(env.get("MAKA_PROVIDER") or provider or "deepseek"),
            env["MAKA_API_KEY"],
        )
    if env.get("MAKA_TASK_RUN_OUT_DIR"):
        env.setdefault("MAKA_OUTPUT_DIR", env["MAKA_TASK_RUN_OUT_DIR"])
        env.setdefault("MAKA_STORAGE_ROOT", str(Path(env["MAKA_TASK_RUN_OUT_DIR"]) / "runs"))
    if env.get("MAKA_HARBOR_MAX_ATTEMPTS"):
        env.setdefault("MAKA_MAX_ATTEMPTS", env["MAKA_HARBOR_MAX_ATTEMPTS"])
    if env.get("MAKA_AUTONOMOUS_MAX_ATTEMPTS"):
        env.setdefault("MAKA_MAX_ATTEMPTS", env["MAKA_AUTONOMOUS_MAX_ATTEMPTS"])
    if env.get("MAKA_AUTONOMOUS_MAX_RUNTIME_STEPS"):
        env.setdefault("MAKA_MAX_RUNTIME_STEPS", env["MAKA_AUTONOMOUS_MAX_RUNTIME_STEPS"])
    if env.get("MAKA_AUTONOMOUS_MAX_WALL_TIME_SEC"):
        env.setdefault("MAKA_MAX_WALL_TIME_SEC", env["MAKA_AUTONOMOUS_MAX_WALL_TIME_SEC"])
    if env.get("MAKA_HARBOR_REPLAY_PRIOR_ATTEMPT_RUNTIME_CONTEXT"):
        env.setdefault(
            "MAKA_REPLAY_PRIOR_ATTEMPT_RUNTIME_CONTEXT",
            env["MAKA_HARBOR_REPLAY_PRIOR_ATTEMPT_RUNTIME_CONTEXT"],
        )
    if env.get("MAKA_HARBOR_HEAVY_TASK_MODE"):
        env.setdefault("MAKA_HEAVY_TASK_MODE", env["MAKA_HARBOR_HEAVY_TASK_MODE"])
    env.setdefault("MAKA_BACKEND", "ai-sdk")


def _provider_api_key_env(provider: str) -> str:
    if provider == "zai-coding-plan":
        return "ZAI_API_KEY"
    if provider == "moonshot":
        return "MOONSHOT_API_KEY"
    if provider == "google":
        return "GOOGLE_API_KEY"
    if provider in {"anthropic", "kimi-coding-plan", "claude-subscription"}:
        return "ANTHROPIC_API_KEY"
    if provider in {"openai", "openai-compatible"}:
        return "OPENAI_API_KEY"
    return "DEEPSEEK_API_KEY"


def _headless_harbor_command(
    *,
    cli_path: Path,
    instruction_path: Path,
    task_workdir: str,
    task_id: str,
    out_dir: Path,
    env: dict[str, str],
    node_path: str | Path = "node",
    isolation: str = "harbor-http",
) -> list[str]:
    command = [
        str(node_path),
        str(cli_path),
        "harbor",
        "run",
        "--mode",
        "task-run",
        "--backend",
        env.get("MAKA_BACKEND", "ai-sdk"),
        "--isolation",
        isolation,
        "--instruction-file",
        str(instruction_path),
        "--workdir",
        task_workdir,
        "--task-id",
        task_id,
        "--task-run-id",
        env.get("MAKA_TASK_RUN_ID", f"harbor-{task_id}"),
        "--out",
        str(out_dir),
        "--storage-root",
        env.get("MAKA_STORAGE_ROOT", str(out_dir / "runs")),
        "--include-events",
    ]
    if env.get("MAKA_PROVIDER"):
        command.extend(["--provider", env["MAKA_PROVIDER"]])
    if env.get("MAKA_MODEL"):
        command.extend(["--model", env["MAKA_MODEL"]])
    if env.get("MAKA_HARBOR_USE_TASK_RUN") == "1" and env.get("MAKA_HARBOR_AUTONOMOUS", "1") != "0":
        command.append("--autonomous")
    if env.get("MAKA_HEAVY_TASK_MODE") in {"1", "true", "TRUE", "yes", "on", "enabled"}:
        command.append("--heavy-task")
    return command


def _redacted_command(command: list[str]) -> list[str]:
    redacted: list[str] = []
    skip_next = False
    for arg in command:
        if skip_next:
            redacted.append("<redacted>")
            skip_next = False
            continue
        redacted.append(arg)
        if arg in {"--api-key", "--api-key-file"}:
            skip_next = True
    return redacted


def _task_run_summary(parsed: dict[str, Any]) -> dict[str, Any]:
    return {
        "taskRunId": parsed.get("taskRunId"),
        "status": parsed.get("status"),
        "taxonomy": parsed.get("taxonomy"),
        "scored": parsed.get("scored"),
        "authoritative": parsed.get("authoritative"),
        "exportDir": parsed.get("exportDir"),
        "files": parsed.get("files"),
        "result": parsed.get("result"),
    }


def _runner_env_summary(env: dict[str, str]) -> dict[str, str]:
    allowed_keys = [
        "MAKA_REPO_DIR",
        "MAKA_MODEL",
        "MAKA_MAX_STEPS",
        "MAKA_TASK_RUN_OUT_DIR",
        "MAKA_OUTPUT_DIR",
        "MAKA_STORAGE_ROOT",
        "MAKA_BACKEND",
        "MAKA_PROVIDER",
        "MAKA_HARBOR_MODE",
        "MAKA_HARBOR_USE_TASK_RUN",
        "MAKA_HARBOR_AUTONOMOUS",
        "MAKA_AUTONOMOUS",
        "MAKA_HARBOR_REPLAY_PRIOR_ATTEMPT_RUNTIME_CONTEXT",
        "MAKA_REPLAY_PRIOR_ATTEMPT_RUNTIME_CONTEXT",
        "MAKA_HEAVY_TASK_MODE",
        "MAKA_AGENT_TOOLS",
        "MAKA_CONTEXT_STALE_TOOL_RESULT_PRUNE",
        "MAKA_CONTEXT_STALE_TOOL_RESULT_MAX_ESTIMATED_TOKENS",
        "MAKA_CONTEXT_STALE_TOOL_RESULT_MIN_RECENT_TURNS_FULL",
        "MAKA_CONTEXT_ACTIVE_TOOL_RESULT_PRUNE",
        "MAKA_CONTEXT_ACTIVE_TOOL_RESULT_MAX_ESTIMATED_TOKENS",
        "MAKA_CONTEXT_ACTIVE_TOOL_RESULT_MIN_STEP_NUMBER",
        "MAKA_CONTEXT_ACTIVE_TOOL_RESULT_ARCHIVE_REQUIRED",
        "MAKA_CONTEXT_ACTIVE_FULL_COMPACT",
        "MAKA_CONTEXT_ACTIVE_FULL_COMPACT_MODE",
        "MAKA_CONTEXT_ACTIVE_FULL_COMPACT_MIN_STEP_NUMBER",
        "MAKA_CONTEXT_ACTIVE_FULL_COMPACT_HIGH_WATER_RATIO",
        "MAKA_CONTEXT_ACTIVE_FULL_COMPACT_FORCE_RATIO",
        "MAKA_CONTEXT_ACTIVE_FULL_COMPACT_TARGET_RATIO",
        "MAKA_CONTEXT_ACTIVE_FULL_COMPACT_MAX_ACTIVE_ESTIMATED_TOKENS",
        "MAKA_CONTEXT_ACTIVE_FULL_COMPACT_MIN_RECENT_MESSAGES",
        "MAKA_CONTEXT_ACTIVE_FULL_COMPACT_MIN_RECENT_TOOL_PAIRS",
        "MAKA_CONTEXT_ACTIVE_FULL_COMPACT_MAX_SUMMARY_ESTIMATED_TOKENS",
        "MAKA_CONTEXT_ACTIVE_FULL_COMPACT_ARCHIVE_REQUIRED",
        "MAKA_CONTEXT_ACTIVE_FULL_COMPACT_HIGH_WATER_NAME",
        "MAKA_CONTEXT_ARCHIVE_RETRIEVAL",
        "MAKA_HARBOR_MAX_ATTEMPTS",
        "MAKA_AUTONOMOUS_MAX_ATTEMPTS",
        "MAKA_AUTONOMOUS_MAX_RUNTIME_STEPS",
        "MAKA_AUTONOMOUS_MAX_WALL_TIME_MS",
        "MAKA_CELL_TIMEOUT_SEC",
        "MAKA_CELL_SOFT_TIMEOUT_MS",
        "MAKA_CELL_SETTLEMENT_GRACE_SEC",
        "MAKA_AGENT_PHASE_TIMEOUT_SEC",
        "MAKA_CELL_DEADLINE_AT_MS",
    ]
    return {key: env[key] for key in allowed_keys if key in env}


def _last_absolute_path(text: str) -> str | None:
    for line in reversed(text.splitlines()):
        stripped = line.strip()
        if stripped.startswith("/"):
            return stripped
    return None


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _int_or_none(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None
