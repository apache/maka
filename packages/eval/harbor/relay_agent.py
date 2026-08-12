"""One-shot Harbor/Pier Agent that delegates one subject execution to @maka/eval."""

from __future__ import annotations

import asyncio
import contextlib
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
        scope_path = f"/tmp/maka-eval-{self._token}.pid"
        output_path = f"/tmp/maka-eval-{self._token}.stdout"
        try:
            await _send(writer, {"token": self._token, "kind": "ready", "instruction": instruction})
            request = json.loads(await reader.readline())
            _require_message(request, self._token, "execute")
            command = await _prepare_command(
                environment, request, self._token, scope_path, output_path
            )
            execution = asyncio.create_task(environment.exec(command, cwd=request["cwd"]))
            control = asyncio.create_task(reader.readline())
            done, _ = await asyncio.wait({execution, control}, return_when=asyncio.FIRST_COMPLETED)
            cancelled = control in done
            if cancelled:
                _require_message(json.loads(control.result()), self._token, "cancel")
            result = await _settle(environment, request, scope_path, execution)
            stdout = await _read_subject_output(environment, output_path)
            await _send(
                writer,
                {
                    "token": self._token,
                    "kind": "executed",
                    "termination": "cancelled" if cancelled else "exited",
                    "exitCode": 130 if cancelled else result.return_code,
                    "stdout": stdout,
                },
            )
            decision = json.loads(await (reader.readline() if cancelled else control))
            if decision.get("token") != self._token or decision.get("kind") != "verify":
                raise RuntimeError("Maka Eval aborted the Trial before verification")
        except asyncio.CancelledError:
            if request is not None and execution is not None:
                result = await _settle(environment, request, scope_path, execution)
                stdout = await _read_subject_output(environment, output_path)
                with contextlib.suppress(BaseException):
                    await _send(
                        writer,
                        {
                            "token": self._token,
                            "kind": "executed",
                            "termination": "framework_timeout",
                            "exitCode": 124,
                            "stdout": stdout,
                        },
                    )
            raise
        except BaseException:
            if request is not None and execution is not None:
                await _settle_or_destroy(environment, request, scope_path, execution)
            raise
        finally:
            if control is not None:
                control.cancel()
                with contextlib.suppress(BaseException):
                    await control
            if request is not None:
                with contextlib.suppress(BaseException):
                    await environment.exec(
                        f"rm -f -- {shlex.quote(scope_path)} {shlex.quote(output_path)}",
                        cwd=request["cwd"],
                        timeout_sec=10,
                    )
            writer.close()
            await writer.wait_closed()


async def _prepare_command(
    environment: Any,
    request: dict[str, Any],
    token: str,
    scope_path: str,
    output_path: str | None = None,
) -> str:
    output_path = output_path or f"/tmp/maka-eval-{token}.stdout"
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
    output_target = output_path if capture_stdout else "/dev/null"
    initialize_output = f": > {shlex.quote(output_path)}; " if capture_stdout else ""
    inner = (
        f"umask 077; {initialize_output}"
        f"echo $$ > {shlex.quote(scope_path)}; "
        f". {shlex.quote(container_path)}; command -p rm -f {shlex.quote(container_path)}; "
        f"exec {subject} >{shlex.quote(output_target)}"
    )
    return f"setsid --wait sh -c {shlex.quote(inner)}"


async def _read_subject_output(environment: Any, output_path: str) -> str:
    with tempfile.TemporaryDirectory() as directory:
        target = Path(directory) / "stdout"
        try:
            await environment.download_file(output_path, target)
            return target.read_text(encoding="utf-8")
        except (FileNotFoundError, OSError):
            return ""


async def _settle(environment: Any, request: dict[str, Any], scope_path: str, execution: Any) -> Any:
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
                        cwd=request["cwd"],
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
                await _signal(environment, request["cwd"], scope_path, signal)
                try:
                    result = await asyncio.wait_for(asyncio.shield(execution), timeout=timeout)
                    break
                except TimeoutError:
                    pass
        if result is None:
            raise RuntimeError("Maka Eval subject did not settle")
    await _quiesce_scope(environment, request["cwd"], scope_path)
    return result


async def _settle_or_destroy(environment: Any, request: dict[str, Any], scope_path: str, execution: Any) -> None:
    try:
        await _settle(environment, request, scope_path, execution)
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


async def _send(writer: asyncio.StreamWriter, value: object) -> None:
    writer.write((json.dumps(value, separators=(",", ":")) + "\n").encode())
    await writer.drain()
