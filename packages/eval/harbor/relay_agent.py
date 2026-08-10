"""One-shot Harbor/Pier Agent that delegates one subject execution to @maka/eval."""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
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
        try:
            await _send(writer, {"token": self._token, "kind": "ready", "instruction": instruction})
            request = json.loads(await reader.readline())
            _require_message(request, self._token, "execute")
            command = await _prepare_command(environment, request, self._token, scope_path)
            execution = asyncio.create_task(environment.exec(command, cwd=request["cwd"]))
            control = asyncio.create_task(reader.readline())
            done, _ = await asyncio.wait({execution, control}, return_when=asyncio.FIRST_COMPLETED)
            cancelled = control in done
            if cancelled:
                _require_message(json.loads(control.result()), self._token, "cancel")
            result = await _settle(environment, request, scope_path, execution)
            await _send(
                writer,
                {
                    "token": self._token,
                    "kind": "executed",
                    "termination": "cancelled" if cancelled else "exited",
                    "exitCode": 130 if cancelled else result.return_code,
                    "stdout": result.stdout or "",
                },
            )
            decision = json.loads(await (reader.readline() if cancelled else control))
            if decision.get("token") != self._token or decision.get("kind") != "verify":
                raise RuntimeError("Maka Eval aborted the Trial before verification")
        except asyncio.CancelledError:
            if request is not None and execution is not None:
                result = await _settle(environment, request, scope_path, execution)
                with contextlib.suppress(BaseException):
                    await _send(
                        writer,
                        {
                            "token": self._token,
                            "kind": "executed",
                            "termination": "framework_timeout",
                            "exitCode": 124,
                            "stdout": result.stdout or "",
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
            writer.close()
            await writer.wait_closed()


async def _prepare_command(
    environment: Any, request: dict[str, Any], token: str, scope_path: str
) -> str:
    credentials = request.get("credentials")
    if not isinstance(credentials, dict) or not all(
        isinstance(key, str) and isinstance(value, str) for key, value in credentials.items()
    ):
        raise RuntimeError("invalid Maka Eval credentials")
    container_path = f"/tmp/maka-eval-{token}.env"
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=False) as secret:
        secret_path = Path(secret.name)
        os.chmod(secret_path, 0o600)
        for key, value in credentials.items():
            if not key or not key.replace("_", "a").isalnum() or key[0].isdigit():
                raise RuntimeError("invalid Maka Eval credential name")
            secret.write(f"export {key}={shlex.quote(value)}\n")
    try:
        await environment.upload_file(secret_path, container_path)
    finally:
        secret_path.unlink(missing_ok=True)
    subject = shlex.join([request["command"], *request["args"]])
    inner = f"echo $$ > {shlex.quote(scope_path)}; . {shlex.quote(container_path)}; rm -f {shlex.quote(container_path)}; exec {subject}"
    return f"setsid sh -c {shlex.quote(inner)}"


async def _settle(environment: Any, request: dict[str, Any], scope_path: str, execution: Any) -> Any:
    if execution.done():
        return execution.result()
    cancel = request.get("cancel")
    if isinstance(cancel, dict):
        with contextlib.suppress(BaseException):
            result = await asyncio.wait_for(
                environment.exec(shlex.join([cancel["command"], *cancel["args"]]), cwd=request["cwd"]),
                timeout=10,
            )
            if result.return_code == 0:
                try:
                    return await asyncio.wait_for(asyncio.shield(execution), timeout=30)
                except TimeoutError:
                    pass
    for signal, timeout in (("TERM", 20), ("KILL", 10)):
        await _signal(environment, request["cwd"], scope_path, signal)
        try:
            return await asyncio.wait_for(asyncio.shield(execution), timeout=timeout)
        except TimeoutError:
            pass
    raise RuntimeError("Maka Eval subject did not settle")


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


def _require_message(value: dict[str, Any], token: str, kind: str) -> None:
    if value.get("token") != token or value.get("kind") != kind:
        raise RuntimeError("invalid Maka Eval relay message")


async def _send(writer: asyncio.StreamWriter, value: object) -> None:
    writer.write((json.dumps(value, separators=(",", ":")) + "\n").encode())
    await writer.drain()
