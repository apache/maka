"""One-shot Harbor/Pier Agent that delegates one subject execution to @maka/eval."""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import os
import re
import shlex
import tempfile
from pathlib import Path
from typing import Any

framework = os.environ.get("MAKA_EVAL_FRAMEWORK")
if framework == "harbor":
    from harbor.agents.base import BaseAgent
elif framework == "pier":
    from pier.agents.base import BaseAgent
else:
    raise RuntimeError("MAKA_EVAL_FRAMEWORK must be harbor or pier")


class RelayTransportClosed(RuntimeError):
    pass


class RelayAgent(BaseAgent):
    def __init__(self, *args: Any, relay_host: str, relay_port: int, relay_token: str, **kwargs: Any):
        super().__init__(*args, **kwargs)
        self._host = relay_host
        self._port = relay_port
        self._token = relay_token

    @staticmethod
    def name() -> str:
        return "maka-eval-relay"

    def version(self) -> str:
        return "1"

    async def setup(self, environment: Any) -> None:
        return None

    async def run(self, instruction: str, environment: Any, context: Any) -> None:
        reader, writer = await asyncio.open_connection(self._host, self._port)
        execution: asyncio.Task[Any] | None = None
        control: asyncio.Task[bytes] | None = None
        request: dict[str, Any] | None = None
        scope_path = f"/logs/agent/.maka-eval-{self._token}.pid"
        try:
            working_directory = await environment.exec("pwd")
            cwd = str(working_directory.stdout or "").strip()
            if working_directory.return_code != 0 or not cwd.startswith("/"):
                raise RuntimeError("Maka Eval could not resolve the task working directory")
            if not await _send(
                writer,
                {
                    "token": self._token,
                    "kind": "ready",
                    "instruction": instruction,
                    "cwd": cwd,
                },
            ):
                raise RelayTransportClosed("Maka Eval relay transport closed before ready")
            request = json.loads(await reader.readline())
            _require_message(request, self._token, "execute")
            command = await _prepare_command(environment, request, self._token, scope_path)
            execution = asyncio.create_task(environment.exec(command, cwd=cwd))
            control = asyncio.create_task(reader.readline())
            done, _ = await asyncio.wait({execution, control}, return_when=asyncio.FIRST_COMPLETED)
            execution_terminal = execution in done
            cancelled = control in done and not execution_terminal
            if control in done:
                _require_message(json.loads(control.result()), self._token, "cancel")
                control = None
            result = await _settle(environment, request, cwd, scope_path, execution)
            stdout = str(getattr(result, "stdout", "") or "")
            if not await _send(
                writer,
                {
                    "token": self._token,
                    "kind": "executed",
                    "termination": "cancelled" if cancelled else "exited",
                    "exitCode": 130 if cancelled else result.return_code,
                    "stdout": stdout,
                    "diagnostic": _process_diagnostic(result),
                },
            ):
                raise RelayTransportClosed("Maka Eval relay transport closed before result")
            decision = json.loads(await (control if control is not None else reader.readline()))
            if execution_terminal and decision.get("kind") == "cancel":
                _require_message(decision, self._token, "cancel")
                decision = json.loads(await reader.readline())
            if decision.get("token") != self._token or decision.get("kind") != "verify":
                raise RuntimeError("Maka Eval aborted the Trial before verification")
        except asyncio.CancelledError:
            if request is not None and execution is not None:
                result = await _settle(environment, request, cwd, scope_path, execution)
                stdout = str(getattr(result, "stdout", "") or "")
                with contextlib.suppress(BaseException):
                    await _send(
                        writer,
                        {
                            "token": self._token,
                            "kind": "executed",
                            "termination": "framework_timeout",
                            "exitCode": 124,
                            "stdout": stdout,
                            "diagnostic": _process_diagnostic(result),
                        },
                    )
            raise
        except BaseException:
            if request is not None and execution is not None:
                await _settle_or_destroy(environment, request, cwd, scope_path, execution)
            raise
        finally:
            if control is not None:
                control.cancel()
                with contextlib.suppress(BaseException):
                    await control
            if request is not None:
                with contextlib.suppress(BaseException):
                    await environment.exec(
                        f"rm -f -- {shlex.quote(scope_path)}",
                        cwd=cwd,
                        timeout_sec=10,
                    )
            with contextlib.suppress(BrokenPipeError, ConnectionError, RuntimeError):
                writer.close()
                await writer.wait_closed()


async def _prepare_command(
    environment: Any,
    request: dict[str, Any],
    token: str,
    scope_path: str,
) -> str:
    credentials = request.get("credentials")
    public_environment = request.get("environment", {})
    if not isinstance(credentials, dict) or not all(
        isinstance(key, str) and isinstance(value, str) for key, value in credentials.items()
    ):
        raise RuntimeError("invalid Maka Eval credentials")
    if not isinstance(public_environment, dict) or not all(
        isinstance(key, str) and isinstance(value, str)
        for key, value in public_environment.items()
    ):
        raise RuntimeError("invalid Maka Eval environment")
    if set(credentials) & set(public_environment):
        raise RuntimeError("Maka Eval environment overlaps credentials")
    capture_stdout = request.get("captureStdout", True)
    if not isinstance(capture_stdout, bool):
        raise RuntimeError("invalid Maka Eval stdout policy")
    for label, values in (("environment", public_environment), ("credential", credentials)):
        if any(re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key) is None for key in values):
            raise RuntimeError(f"invalid Maka Eval {label} name")

    container_path = f"/tmp/maka-eval-{token}.env"
    secret_path = None
    try:
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=False) as secret:
            secret_path = Path(secret.name)
            os.chmod(secret_path, 0o600)
            for key, value in {**public_environment, **credentials}.items():
                secret.write(f"export {key}={shlex.quote(value)}\n")
        await environment.upload_file(secret_path, container_path)
    finally:
        if secret_path is not None:
            secret_path.unlink(missing_ok=True)
    subject = shlex.join([request["command"], *request["args"]])
    output_redirect = "" if capture_stdout else " >/dev/null"
    inner = (
        "umask 077; "
        f"echo $$ > {shlex.quote(scope_path)}; "
        f". {shlex.quote(container_path)}; command -p rm -f {shlex.quote(container_path)}; "
        f"exec {subject}{output_redirect}"
    )
    return f"setsid --wait sh -c {shlex.quote(inner)}"


def _process_diagnostic(result: Any) -> dict[str, Any]:
    stderr = str(getattr(result, "stderr", "") or "").encode("utf-8", errors="replace")
    return {
        "category": "process-stderr" if stderr else "none",
        "stderrBytes": len(stderr),
        "stderrSha256": hashlib.sha256(stderr).hexdigest(),
    }


async def _settle(
    environment: Any, request: dict[str, Any], cwd: str, scope_path: str, execution: Any
) -> Any:
    if execution.done():
        result = execution.result()
    else:
        result = None
        cancel = request.get("cancel")
        if isinstance(cancel, dict):
            with contextlib.suppress(BaseException):
                cancelled = await asyncio.wait_for(
                    environment.exec(
                        shlex.join([cancel["command"], *cancel["args"]]),
                        cwd=cwd,
                    ),
                    timeout=10,
                )
                if cancelled.return_code == 0:
                    try:
                        result = await asyncio.wait_for(asyncio.shield(execution), timeout=30)
                    except TimeoutError:
                        pass
        if result is None:
            for signal, timeout in (("TERM", 20), ("KILL", 10)):
                await _signal(environment, cwd, scope_path, signal)
                try:
                    result = await asyncio.wait_for(asyncio.shield(execution), timeout=timeout)
                    break
                except TimeoutError:
                    pass
        if result is None:
            raise RuntimeError("Maka Eval subject did not settle")
    await _quiesce_scope(environment, cwd, scope_path)
    return result


async def _settle_or_destroy(
    environment: Any, request: dict[str, Any], cwd: str, scope_path: str, execution: Any
) -> None:
    try:
        await _settle(environment, request, cwd, scope_path, execution)
    except BaseException:
        with contextlib.suppress(BaseException):
            await environment.stop(delete=True)


async def _signal(environment: Any, cwd: str, scope_path: str, signal: str) -> None:
    with contextlib.suppress(BaseException):
        await environment.exec(
            f"kill -{signal} -- -$(cat {shlex.quote(scope_path)})",
            cwd=cwd,
            timeout_sec=10,
        )


async def _quiesce_scope(environment: Any, cwd: str, scope_path: str) -> None:
    if not await _scope_active(environment, cwd, scope_path):
        return
    for signal, timeout in (("TERM", 10), ("KILL", 5)):
        await _signal(environment, cwd, scope_path, signal)
        deadline = asyncio.get_running_loop().time() + timeout
        while asyncio.get_running_loop().time() < deadline:
            if not await _scope_active(environment, cwd, scope_path):
                return
            await asyncio.sleep(0.1)
    raise RuntimeError("Maka Eval execution scope did not quiesce")


async def _scope_active(environment: Any, cwd: str, scope_path: str) -> bool:
    result = await environment.exec(
        f"test -r {shlex.quote(scope_path)} && "
        f"kill -0 -- -$(cat {shlex.quote(scope_path)}) 2>/dev/null",
        cwd=cwd,
        timeout_sec=5,
    )
    return result.return_code == 0


def _require_message(value: dict[str, Any], token: str, kind: str) -> None:
    if value.get("token") != token or value.get("kind") != kind:
        raise RuntimeError("invalid Maka Eval relay message")


async def _send(writer: asyncio.StreamWriter, value: object) -> bool:
    if writer.is_closing():
        return False
    try:
        writer.write((json.dumps(value, separators=(",", ":")) + "\n").encode())
        await writer.drain()
        return True
    except (BrokenPipeError, ConnectionError, RuntimeError):
        return False
