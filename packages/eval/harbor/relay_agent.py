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

"""One-shot Harbor/Pier Agent that delegates one subject execution to @maka/eval."""

from __future__ import annotations

import asyncio
import base64
import contextlib
import hashlib
import json
import os
import re
import shlex
import tempfile
from pathlib import Path
from typing import Any

from eval_framework import selected

framework = selected()
if framework == "harbor":
    from harbor.agents.base import BaseAgent
else:
    from pier.agents.base import BaseAgent


class RelayTransportClosed(RuntimeError):
    pass


RESULT_FRAME_PREFIX = "MAKA-EVAL-RESULT-V1"
SCOPE_ERROR_PREFIX = "MAKA-EVAL-SCOPE-ERROR-V1"
RESULT_PAYLOAD_LIMIT_BYTES = 2 * 1024
RESULT_CARRIER_LIMIT_BYTES = 64 * 1024
SUBJECT_STDOUT_PATH = "/logs/artifacts/maka-subject.stdout.txt"
SUBJECT_STDERR_PATH = "/logs/artifacts/maka-subject.stderr.txt"
CAPABILITY_PREFIX = "MAKA-EVAL-CAPABILITIES-V1 "
NAMESPACE_PREFIX = "MAKA-EVAL-POLICY-NAMESPACE-V1 "
# The egress policy only constrains what the IP output hooks can see. NET_RAW
# grants an AF_PACKET socket that writes beneath them, and NET_ADMIN grants the
# ability to delete the ruleset outright. The overlay drops NET_RAW, but a
# task's own compose can add either back, and a `cap_add` wins over an
# overlay's `cap_drop`.
BYPASS_CAPABILITIES = {"NET_RAW": 1 << 13, "NET_ADMIN": 1 << 12}
# Every set is read, not just the effective one: a non-root subject reports an
# empty effective set while a file-capability executable still reacquires
# anything the bounding set kept, and the permitted, inheritable and ambient
# sets each raise into the effective set without an exec at all.
CAPABILITY_FIELDS = ("CapEff", "CapPrm", "CapBnd")
# Harbor installs the policy by running `network-policy` inside this service, so
# its network namespace is what "the namespace the policy was applied to" means.
# Reading the identity from both sides answers that question directly, rather
# than inferring it from something only the shared namespace would expose.
POLICY_SERVICE = "harbor-docker-egress-control-sidecar"
NAMESPACE_PROBE = f"printf %s {shlex.quote(NAMESPACE_PREFIX)}; readlink /proc/self/ns/net"
PROXY_IPV4_PATH = "/opt/maka-egress/proxy-ipv4"
PROXY_HOSTS_PREFIX = "MAKA-EVAL-PROXY-HOST-V1 "
# The kernel's own form for a namespace link target. Matching it keeps an
# unexpected answer from being compared as if it were an identity.
NAMESPACE_IDENTITY = re.compile(r"^net:\[[0-9]+\]$")

_host_teardown_requested = False


def request_host_teardown() -> None:
    global _host_teardown_requested
    _host_teardown_requested = True


class RelayAgent(BaseAgent):
    def __init__(
        self,
        *args: Any,
        relay_host: str,
        relay_port: int,
        relay_token: str,
        teardown_timeout_ms: int,
        **kwargs: Any,
    ):
        super().__init__(*args, **kwargs)
        self._host = relay_host
        self._port = relay_port
        self._token = relay_token
        if not isinstance(teardown_timeout_ms, int) or teardown_timeout_ms <= 0:
            raise RuntimeError("Maka Eval teardown timeout is invalid")
        self._teardown_timeout = teardown_timeout_ms / 1000

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
        decision: asyncio.Task[dict[str, Any]] | None = None
        request: dict[str, Any] | None = None
        execution_reported = False
        scope_path = f"/logs/agent/.maka-eval-{self._token}.pid"
        environment_path = f"/tmp/maka-eval-{self._token}.env"
        try:
            cwd_prefix = f"MAKA-EVAL-CWD-V1 {self._token} "
            working_directory = await environment.exec(
                f"printf {shlex.quote(cwd_prefix)}; pwd 2>/dev/null"
            )
            cwd_lines = [
                line[len(cwd_prefix) :]
                for line in str(working_directory.stdout or "").splitlines()
                if line.startswith(cwd_prefix)
            ]
            cwd = cwd_lines[0] if len(cwd_lines) == 1 else ""
            if working_directory.return_code != 0 or not cwd.startswith("/") or "\x00" in cwd:
                raise RuntimeError("Maka Eval could not resolve the task working directory")
            await _require_constrained_subject(environment)
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
            request = await _receive(reader)
            _require_message(request, self._token, "execute")
            command = await _prepare_command(environment, request, self._token, scope_path)
            execution = asyncio.create_task(environment.exec(command, cwd=cwd))
            decision = asyncio.create_task(_receive(reader))
            done, _ = await asyncio.wait({execution, decision}, return_when=asyncio.FIRST_COMPLETED)
            if decision in done and execution not in done:
                decision.result()
                raise RelayTransportClosed("Maka Eval relay received control before execution")
            result = execution.result()
            await _persist_subject_outputs(environment, result)
            stdout, diagnostic = _project_result(result, request)
            # A subject that exited on its own leaves the shared environment as
            # it left it, and the verifier reads that environment. Nothing is
            # waiting on those processes here — `environment.exec` has already
            # returned — so tearing them down would not unblock anything; it
            # would only edit the thing about to be measured, and edit it for
            # some subjects and not others. Cancellation still quiesces, because
            # there the subject has not stopped and the trial is being abandoned.
            if not await _send(
                writer,
                {
                    "token": self._token,
                    "kind": "executed",
                    "termination": "exited",
                    "exitCode": result.return_code,
                    "stdout": stdout,
                    "diagnostic": diagnostic,
                },
            ):
                raise RelayTransportClosed("Maka Eval relay transport closed before result")
            execution_reported = True
            _require_message(
                decision.result() if decision.done() else await decision,
                self._token,
                "verify",
            )
        except asyncio.CancelledError:
            if request is not None and execution is not None:
                execution_terminal = execution.done() and not execution.cancelled()
                terminal_projection = None
                if execution_terminal:
                    terminal_result = execution.result()
                    terminal_projection = _project_result(terminal_result, request)
                # A subject that already exited has nothing left to settle, and
                # tearing its scope down here would remove what the verifier is
                # about to score -- the same environment edit this relay stopped
                # making on the ordinary path. Only a subject still running is
                # brought to a stop.
                if terminal_projection is not None:
                    result = terminal_result
                else:
                    result = await _settle_or_destroy(
                        environment, cwd, scope_path, execution, self._teardown_timeout
                    )
                if result is not None:
                    await _persist_subject_outputs(environment, result)
                if (
                    result is not None
                    and not execution_reported
                    and (execution_terminal or not _host_teardown_requested)
                ):
                    stdout, diagnostic = terminal_projection or _project_result(result, request)
                    with contextlib.suppress(Exception):
                        await _send(
                            writer,
                            {
                                "token": self._token,
                                "kind": "executed",
                                "termination": "exited" if execution_terminal else "framework_timeout",
                                "exitCode": result.return_code if execution_terminal else 124,
                                "stdout": stdout,
                                "diagnostic": diagnostic,
                            },
                        )
                elif not execution_reported and not _host_teardown_requested:
                    with contextlib.suppress(Exception):
                        await _send(
                            writer,
                            {
                                "token": self._token,
                                "kind": "executed",
                                "termination": "framework_timeout",
                                "exitCode": 124,
                                "stdout": "",
                                "diagnostic": (
                                    _carrier_diagnostic("result-frame-missing", b"")
                                    if request.get("captureStdout", True)
                                    else {"category": "none"}
                                ),
                            },
                        )
            raise
        except RelayTransportClosed:
            if request is not None and execution is not None:
                result = await _settle_or_destroy(
                    environment, cwd, scope_path, execution, self._teardown_timeout
                )
                if result is not None:
                    with contextlib.suppress(Exception):
                        await _persist_subject_outputs(environment, result)
        except BaseException:
            if request is not None and execution is not None:
                result = await _settle_or_destroy(
                    environment, cwd, scope_path, execution, self._teardown_timeout
                )
                if result is not None:
                    with contextlib.suppress(Exception):
                        await _persist_subject_outputs(environment, result)
            raise
        finally:
            if decision is not None and not decision.done():
                decision.cancel()
                with contextlib.suppress(BaseException):
                    await decision
            if request is not None:
                with contextlib.suppress(Exception):
                    await asyncio.wait_for(
                        environment.exec(
                            f"rm -f -- {shlex.quote(scope_path)} {shlex.quote(environment_path)}",
                            cwd=cwd,
                            timeout_sec=1,
                        ),
                        timeout=1,
                    )
            with contextlib.suppress(BrokenPipeError, ConnectionError, RuntimeError, TimeoutError):
                writer.close()
                await asyncio.wait_for(writer.wait_closed(), timeout=1)


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
    result_token = request.get("resultToken")
    if not isinstance(result_token, str) or re.fullmatch(r"[0-9a-f]{32}", result_token) is None:
        raise RuntimeError("invalid Maka Eval result token")
    if "MAKA_EVAL_RESULT_TOKEN" in credentials or "MAKA_EVAL_RESULT_TOKEN" in public_environment:
        raise RuntimeError("Maka Eval environment contains a reserved name")
    for label, values in (("environment", public_environment), ("credential", credentials)):
        if any(re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key) is None for key in values):
            raise RuntimeError(f"invalid Maka Eval {label} name")

    container_path = f"/tmp/maka-eval-{token}.env"
    secret_path = None
    try:
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=False) as secret:
            secret_path = Path(secret.name)
            os.chmod(secret_path, 0o600)
            for key, value in {
                **public_environment,
                **credentials,
                "MAKA_EVAL_RESULT_TOKEN": result_token,
            }.items():
                secret.write(f"export {key}={shlex.quote(value)}\n")
        await environment.upload_file(secret_path, container_path)
    finally:
        if secret_path is not None:
            secret_path.unlink(missing_ok=True)
    subject = shlex.join([request["command"], *request["args"]])
    output_redirect = "" if capture_stdout else " >/dev/null"
    scope_error = shlex.quote(f"{SCOPE_ERROR_PREFIX} {result_token}\\n")
    inner = (
        "umask 077; "
        f"{{ echo $$ > {shlex.quote(scope_path)}; }} 2>/dev/null || "
        f"{{ printf {scope_error}; exit 111; }}; "
        f". {shlex.quote(container_path)}; command -p rm -f {shlex.quote(container_path)}; "
        f"exec {subject}{output_redirect}"
    )
    return f"setsid --wait sh -c {shlex.quote(inner)}"


async def _require_constrained_subject(environment: Any) -> None:
    """Refuse to start the subject unless the egress policy actually governs it.

    Runs after the policy is applied and before the subject exists, so a task
    that keeps a capability the policy cannot see, or that keeps the subject out
    of the namespace the policy was applied to, fails the attempt instead of
    producing a result the isolation contract never actually covered.
    """
    if os.environ.get("MAKA_EVAL_EGRESS_REQUIRED") != "1":
        return
    probe = await environment.exec(
        f"printf %s {shlex.quote(CAPABILITY_PREFIX)}; "
        r"sed -n 's/^\(Cap[A-Za-z]*\):[[:space:]]*/\1=/p' /proc/self/status | tr '\n' ' '; "
        "echo; " + NAMESPACE_PROBE
    )
    policy = await environment.service_exec(NAMESPACE_PROBE, service=POLICY_SERVICE)
    if probe.return_code != 0 or policy.return_code != 0:
        raise RuntimeError("Maka Eval could not read the subject isolation evidence")
    capabilities = _sole_probe_line(probe, CAPABILITY_PREFIX)
    namespace = _sole_probe_line(probe, NAMESPACE_PREFIX)
    policy_namespace = _sole_probe_line(policy, NAMESPACE_PREFIX)
    if not all(NAMESPACE_IDENTITY.match(value) for value in (namespace, policy_namespace)):
        raise RuntimeError("Maka Eval could not read the subject isolation evidence")
    reported: dict[str, int] = {}
    for field in capabilities.split():
        name, _, value = field.partition("=")
        try:
            reported[name] = int(value, 16)
        except ValueError:
            raise RuntimeError("Maka Eval could not read the subject capability set") from None
    if not all(field in reported for field in CAPABILITY_FIELDS):
        raise RuntimeError("Maka Eval could not read the subject capability set")
    granted = 0
    for value in reported.values():
        granted |= value
    held = sorted(name for name, bit in BYPASS_CAPABILITIES.items() if granted & bit)
    if held:
        raise RuntimeError(
            "the subject holds "
            + ", ".join(held)
            + ", which bypasses the Eval egress policy; remove it from the task"
        )
    if namespace != policy_namespace:
        raise RuntimeError(
            "the subject does not share the network namespace the Eval egress policy "
            "was applied to; remove the task's own networking on the subject service"
        )
    await _pin_proxy_hostname(environment)


HOSTS_ALIAS_AWK = r"""
/^[[:space:]]*#/ { print; next }
{
  for (i = 2; i <= NF; i++) {
    if ($i == host) next
  }
  print
}
"""

# Four decimal octets 0-255, no empty fields and no leading zeros. The same
# program is embedded in egress-proxy/network-policy; the contract test
# requires the two copies to stay identical.
IPV4_OCTET_AWK = r"""
BEGIN { FS = "." }
NF != 4 { exit 1 }
{
  for (i = 1; i <= 4; i++) {
    if ($i !~ /^(0|[1-9][0-9]*)$/ || $i + 0 > 255) exit 1
  }
}
"""

_PUBLISHED_IPV4 = re.compile(
    r"^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}"
    r"(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$"
)


def _valid_egress_proxy_host(host: str) -> bool:
    if not host or host.startswith(".") or host.endswith(".") or ".." in host:
        return False
    # Match the pin script's `*[!A-Za-z0-9.-]*` class. str.isalnum() also
    # accepts Unicode letters, which the shell would later reject as a pin
    # failure instead of an invalid host.
    return all(
        (character.isalnum() and character.isascii()) or character in ".-"
        for character in host
    )


def _valid_published_ipv4(ip: str) -> bool:
    return bool(_PUBLISHED_IPV4.fullmatch(ip))


async def _pin_proxy_hostname(environment: Any) -> None:
    """Point the proxy hostname at the published IPv4 so Docker DNS can be refused.

    The subject only needs that one name, because the HTTP proxy does remote
    resolution itself. Pinning it in /etc/hosts lets the namespace policy reject
    127.0.0.11:53 without breaking HTTPS_PROXY.
    """
    host = os.environ.get("MAKA_EVAL_EGRESS_ALLOWED_HOST") or "maka-eval-mitmproxy"
    if not _valid_egress_proxy_host(host):
        raise RuntimeError("Eval egress proxy host is invalid")
    script = f"""
set -eu
path={shlex.quote(PROXY_IPV4_PATH)}
host={shlex.quote(host)}
case "$host" in
  ""|.*|*..*|*.) exit 1 ;;
  *[!A-Za-z0-9.-]*) exit 1 ;;
esac
test -f "$path"
ip=$(tr -d ' \\t\\r\\n' < "$path")
case "$ip" in
  ""|*.*.*.*.*|*[!0-9.]*) exit 1 ;;
esac
if ! printf '%s\\n' "$ip" | awk {shlex.quote(IPV4_OCTET_AWK)}; then
  exit 1
fi
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
if [ -f /etc/hosts ]; then
  awk -v host="$host" {shlex.quote(HOSTS_ALIAS_AWK)} /etc/hosts > "$tmp"
fi
printf '%s %s\\n' "$ip" "$host" >> "$tmp"
cat "$tmp" > /etc/hosts
printf %s {shlex.quote(PROXY_HOSTS_PREFIX)}
printf '%s %s\\n' "$ip" "$host"
"""
    # Harbor 0.20.0 BaseEnvironment.exec and DockerEnvironment.exec take user=;
    # DockerEnvironment._compose_exec forwards it as `docker compose exec -u`.
    probe = await environment.exec(script, user="root")
    if probe.return_code != 0:
        raise RuntimeError("Maka Eval could not pin the Eval egress proxy hostname")
    reported = _sole_probe_line(probe, PROXY_HOSTS_PREFIX)
    ip, _, pinned = reported.partition(" ")
    if pinned != host or not _valid_published_ipv4(ip):
        raise RuntimeError("Maka Eval could not pin the Eval egress proxy hostname")


def _sole_probe_line(probe: Any, prefix: str) -> str:
    reported = [
        line[len(prefix) :]
        for line in str(probe.stdout or "").splitlines()
        if line.startswith(prefix)
    ]
    if len(reported) != 1:
        raise RuntimeError("Maka Eval could not read the subject isolation evidence")
    return reported[0].strip()


async def _persist_subject_outputs(environment: Any, result: Any) -> None:
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        stdout = root / "stdout"
        stderr = root / "stderr"
        stdout.write_text(str(getattr(result, "stdout", "") or ""), encoding="utf-8")
        stderr.write_text(str(getattr(result, "stderr", "") or ""), encoding="utf-8")
        prepared = await environment.exec("mkdir -p /logs/artifacts && chmod 700 /logs/artifacts")
        if prepared.return_code != 0:
            raise RuntimeError("Maka Eval could not prepare subject artifact output")
        await environment.upload_file(stdout, SUBJECT_STDOUT_PATH)
        await environment.upload_file(stderr, SUBJECT_STDERR_PATH)


def _decode_result_carrier(carrier: str, token: str) -> tuple[str, dict[str, Any]]:
    raw = carrier.encode("utf-8", errors="replace")
    if len(raw) > RESULT_CARRIER_LIMIT_BYTES:
        return "", _carrier_diagnostic("result-frame-oversize", raw)
    prefix = f"{RESULT_FRAME_PREFIX} {token} "
    candidates = [line for line in carrier.splitlines(keepends=True) if line.startswith(prefix)]
    if len(candidates) != 1:
        category = "result-frame-missing" if not candidates else "result-frame-ambiguous"
        return "", _carrier_diagnostic(category, raw)
    frame = candidates[0]
    fields = frame.rstrip("\r\n").split(" ", 4)
    if len(fields) != 5:
        return "", _carrier_diagnostic("result-frame-invalid", raw)
    _, framed_token, length_text, digest, encoded = fields
    try:
        length = int(length_text)
        padding = "=" * (-len(encoded) % 4)
        payload = base64.b64decode(encoded + padding, altchars=b"-_", validate=True)
    except (ValueError, base64.binascii.Error):
        return "", _carrier_diagnostic("result-frame-invalid", raw)
    if (
        framed_token != token
        or length < 0
        or length > RESULT_PAYLOAD_LIMIT_BYTES
        or len(payload) != length
        or not re.fullmatch(r"[0-9a-f]{64}", digest)
        or hashlib.sha256(payload).hexdigest() != digest
    ):
        return "", _carrier_diagnostic("result-frame-invalid", raw)
    noise = carrier.replace(frame, "", 1).encode("utf-8", errors="replace")
    diagnostic = (
        {"category": "none"}
        if not noise
        else _carrier_diagnostic("unstructured-output", noise)
    )
    try:
        decoded = payload.decode("utf-8", errors="strict")
    except UnicodeDecodeError:
        return "", _carrier_diagnostic("result-frame-invalid", raw)
    return decoded, diagnostic


def _project_result(result: Any, request: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    carrier = str(getattr(result, "stdout", "") or "")
    scope_error = f"{SCOPE_ERROR_PREFIX} {request['resultToken']}"
    if carrier == f"{scope_error}\n":
        return "", _carrier_diagnostic("execution-scope-unavailable", carrier.encode())
    if not request.get("captureStdout", True):
        return "", {"category": "none"}
    return _decode_result_carrier(carrier, request["resultToken"])


def _carrier_diagnostic(category: str, value: bytes) -> dict[str, Any]:
    return {
        "category": category,
        "bytes": len(value),
        "sha256": hashlib.sha256(value).hexdigest(),
    }


async def _settle(environment: Any, cwd: str, scope_path: str, execution: Any) -> Any:
    if execution.cancelled():
        raise RuntimeError("Maka Eval subject execution was cancelled")
    if execution.done():
        result = execution.result()
    else:
        result = None
        for signal, timeout in (("TERM", 20), ("KILL", 10)):
            await _signal(environment, cwd, scope_path, signal)
            try:
                result = await asyncio.wait_for(asyncio.shield(execution), timeout=timeout)
                break
            except asyncio.CancelledError:
                if execution.cancelled():
                    raise RuntimeError("Maka Eval subject execution was cancelled") from None
                raise
            except TimeoutError:
                pass
        if result is None:
            raise RuntimeError("Maka Eval subject did not settle")
    await _quiesce_scope(environment, cwd, scope_path)
    return result


async def _settle_or_destroy(
    environment: Any,
    cwd: str,
    scope_path: str,
    execution: Any,
    timeout: float,
) -> Any | None:
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    stop_reserve = min(20.0, timeout * 0.2)
    try:
        return await asyncio.wait_for(
            _settle(environment, cwd, scope_path, execution),
            timeout=max(0.001, deadline - loop.time() - stop_reserve),
        )
    except Exception:
        try:
            remaining = max(0.001, deadline - loop.time())
            await asyncio.wait_for(environment.stop(delete=True), timeout=remaining)
        except Exception:
            pass
        finally:
            if not execution.done():
                execution.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                remaining = max(0.001, deadline - loop.time())
                await asyncio.wait_for(execution, timeout=remaining)
        return None


async def _signal(environment: Any, cwd: str, scope_path: str, signal: str) -> None:
    command = (
        f"pgid=$(cat {shlex.quote(scope_path)} 2>/dev/null) || exit 0; "
        "case $pgid in ''|0|*[!0-9]*) exit 0;; esac; "
        f"kill -{signal} -- \"-$pgid\""
    )
    with contextlib.suppress(Exception):
        await environment.exec(
            command,
            cwd=cwd,
            timeout_sec=5,
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
        f"pgid=$(cat {shlex.quote(scope_path)} 2>/dev/null) || exit 4; "
        "case $pgid in ''|0|*[!0-9]*) exit 4;; esac; "
        "kill -0 -- \"-$pgid\" 2>/dev/null; status=$?; "
        "if [ $status -eq 0 ]; then exit 0; fi; exit 3",
        cwd=cwd,
        timeout_sec=5,
    )
    if result.return_code == 0:
        return True
    if result.return_code == 3:
        return False
    raise RuntimeError("Maka Eval execution scope evidence was unavailable")


def _require_message(value: dict[str, Any], token: str, kind: str) -> None:
    if value.get("token") != token or value.get("kind") != kind:
        raise RuntimeError("invalid Maka Eval relay message")


async def _receive(reader: asyncio.StreamReader) -> dict[str, Any]:
    try:
        raw = await reader.readline()
        if not raw:
            raise RelayTransportClosed("Maka Eval relay peer closed")
        value = json.loads(raw)
    except (ConnectionError, json.JSONDecodeError, ValueError) as error:
        raise RelayTransportClosed("Maka Eval relay message was unavailable") from error
    if not isinstance(value, dict):
        raise RelayTransportClosed("Maka Eval relay message was invalid")
    return value


async def _send(writer: asyncio.StreamWriter, value: object) -> bool:
    if writer.is_closing():
        return False
    try:
        writer.write((json.dumps(value, separators=(",", ":")) + "\n").encode())
        await writer.drain()
        return True
    except (BrokenPipeError, ConnectionError, RuntimeError):
        return False
