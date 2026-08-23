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

import asyncio
import base64
import hashlib
import importlib
import inspect
import os
import shlex
import subprocess
import sys
import tempfile
import types
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch


class BaseAgent:
    def __init__(self, *args, **kwargs):
        pass


class Environment:
    def __init__(self, stage_upload: bool = False):
        self.uploaded = b""
        self.uploaded_target = None
        self.stage_upload = stage_upload

    async def upload_file(self, source: Path, target: str) -> None:
        self.uploaded = source.read_bytes()
        if self.stage_upload:
            self.uploaded_target = Path(target)
            self.uploaded_target.write_bytes(self.uploaded)


def load_relay(framework="harbor"):
    from eval_framework import install

    install(framework)
    package = types.ModuleType(framework)
    agents = types.ModuleType(f"{framework}.agents")
    base = types.ModuleType(f"{framework}.agents.base")
    base.BaseAgent = BaseAgent
    sys.modules[framework] = package
    sys.modules[f"{framework}.agents"] = agents
    sys.modules[f"{framework}.agents.base"] = base
    sys.modules.pop("relay_agent", None)
    return importlib.import_module("relay_agent")


class RelayContractTest(unittest.TestCase):
    def test_merged_noise_cannot_corrupt_or_escape_the_result_frame(self):
        relay = load_relay()
        token = "frame-token"
        payload = b'{"kind":"settled","status":"completed"}'
        encoded = base64.urlsafe_b64encode(payload).decode().rstrip("=")
        frame = (
            f"MAKA-EVAL-RESULT-V1 {token} {len(payload)} "
            f"{hashlib.sha256(payload).hexdigest()} {encoded}\n"
        )
        sentinel = "credential-sentinel-must-not-persist"

        stdout, diagnostic = relay._decode_result_carrier(
            f"docker warning\n{frame}{sentinel}\n", token
        )

        self.assertEqual(stdout, payload.decode())
        self.assertEqual(diagnostic["category"], "unstructured-output")
        self.assertEqual(
            diagnostic["bytes"], len(f"docker warning\n{sentinel}\n".encode())
        )
        self.assertNotIn(sentinel, str({"stdout": stdout, "diagnostic": diagnostic}))

    def test_invalid_result_frames_fail_closed_with_bounded_evidence(self):
        relay = load_relay()
        token = "frame-token"
        payload = b"{}"
        encoded = base64.urlsafe_b64encode(payload).decode().rstrip("=")
        valid = (
            f"MAKA-EVAL-RESULT-V1 {token} {len(payload)} "
            f"{hashlib.sha256(payload).hexdigest()} {encoded}\n"
        )
        cases = {
            "noise only": "result-frame-missing",
            valid + valid: "result-frame-ambiguous",
            valid.replace(hashlib.sha256(payload).hexdigest(), "0" * 64): "result-frame-invalid",
        }
        for carrier, category in cases.items():
            with self.subTest(category=category):
                stdout, diagnostic = relay._decode_result_carrier(carrier, token)
                self.assertEqual(stdout, "")
                self.assertEqual(diagnostic["category"], category)
                self.assertEqual(set(diagnostic), {"category", "bytes", "sha256"})

    def test_non_utf8_result_payload_is_classified_as_an_invalid_frame(self):
        relay = load_relay()
        token = "frame-token"
        payload = b"\xff"
        encoded = base64.urlsafe_b64encode(payload).decode().rstrip("=")
        frame = (
            f"MAKA-EVAL-RESULT-V1 {token} {len(payload)} "
            f"{hashlib.sha256(payload).hexdigest()} {encoded}\n"
        )

        stdout, diagnostic = relay._decode_result_carrier(frame, token)

        self.assertEqual(stdout, "")
        self.assertEqual(diagnostic["category"], "result-frame-invalid")

    def test_oversized_result_carrier_is_rejected_before_parsing(self):
        relay = load_relay()
        carrier = "x" * (relay.RESULT_CARRIER_LIMIT_BYTES + 1)
        stdout, diagnostic = relay._decode_result_carrier(carrier, "frame-token")
        self.assertEqual(stdout, "")
        self.assertEqual(diagnostic["category"], "result-frame-oversize")

    def test_subject_output_cannot_counterfeit_scope_setup_failure(self):
        relay = load_relay()
        token = "0" * 32
        carrier = f"subject output\nMAKA-EVAL-SCOPE-ERROR-V1 {token}\n"

        _, diagnostic = relay._project_result(
            types.SimpleNamespace(stdout=carrier),
            {"captureStdout": False, "resultToken": token},
        )

        self.assertEqual(diagnostic["category"], "none")

    def test_command_keeps_capture_and_control_files_out_of_task_workspace(self):
        relay = load_relay()
        environment = Environment()
        command = asyncio.run(
            relay._prepare_command(
                environment,
                {
                    "command": "/opt/agent",
                    "args": ["run"],
                    "environment": {},
                    "credentials": {},
                    "captureStdout": True,
                    "resultToken": "0" * 32,
                },
                "token",
                "/logs/agent/.maka-eval-token.pid",
            )
        )

        self.assertNotIn(".stdout", command)
        self.assertNotIn(".stderr", command)
        self.assertNotIn("/app", command)
        self.assertIn("/logs/agent/.maka-eval-token.pid", command)
        self.assertIn("2>/dev/null", command)

    def test_command_does_not_start_subject_when_scope_pid_cannot_be_published(self):
        relay = load_relay()
        environment = Environment(stage_upload=True)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            fake_bin = root / "bin"
            fake_bin.mkdir()
            fake_setsid = fake_bin / "setsid"
            fake_setsid.write_text(
                "#!/bin/sh\n"
                "if [ \"$1\" = --wait ]; then shift; fi\n"
                "exec \"$@\"\n"
            )
            fake_setsid.chmod(0o755)
            marker = root / "subject-started"
            scope_path = root / "missing" / "scope.pid"
            command = asyncio.run(
                relay._prepare_command(
                    environment,
                    {
                        "command": "/bin/sh",
                        "args": ["-c", f"touch {shlex.quote(str(marker))}"],
                        "environment": {},
                        "credentials": {},
                        "captureStdout": False,
                        "resultToken": "0" * 32,
                    },
                    "token",
                    str(scope_path),
                )
            )
            try:
                completed = subprocess.run(
                    command,
                    shell=True,
                    check=False,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    env={**os.environ, "PATH": f"{fake_bin}:{os.environ['PATH']}"},
                )
                self.assertFalse(marker.exists())
            finally:
                if environment.uploaded_target is not None:
                    environment.uploaded_target.unlink(missing_ok=True)

        self.assertNotEqual(completed.returncode, 0)
        stdout, diagnostic = relay._project_result(
            types.SimpleNamespace(stdout=completed.stdout.decode()),
            {"captureStdout": False, "resultToken": "0" * 32},
        )
        self.assertEqual(stdout, "")
        self.assertEqual(diagnostic["category"], "execution-scope-unavailable")

    def test_stages_environment_and_discards_unstructured_stdout(self):
        relay = load_relay()
        environment = Environment()
        command = asyncio.run(
            relay._prepare_command(
                environment,
                {
                    "command": "/opt/agent",
                    "args": ["run"],
                    "environment": {"MODE": "offline"},
                    "credentials": {"API_KEY": "canary-secret"},
                    "captureStdout": False,
                    "resultToken": "0" * 32,
                },
                "token",
                "/tmp/scope.pid",
            )
        )

        self.assertIn(b"export MODE=offline", environment.uploaded)
        self.assertIn(b"export API_KEY=canary-secret", environment.uploaded)
        self.assertNotIn("canary-secret", command)
        self.assertIn(">/dev/null", command)

    def test_leaves_no_credential_file_when_command_preparation_fails(self):
        relay = load_relay()
        environment = Environment()
        named_temporary_file = tempfile.NamedTemporaryFile
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(
                relay.tempfile,
                "NamedTemporaryFile",
                side_effect=lambda *args, **kwargs: named_temporary_file(
                    *args, dir=directory, **kwargs
                ),
            ):
                with self.assertRaisesRegex(RuntimeError, "invalid Maka Eval credential name"):
                    asyncio.run(
                        relay._prepare_command(
                            environment,
                            {
                                "command": "/opt/agent",
                                "args": ["run"],
                                "environment": {"MODE": "offline"},
                                "credentials": {
                                    "API_KEY": "canary-secret",
                                    "BAD-NAME": "ignored",
                                },
                                "captureStdout": False,
                                "resultToken": "0" * 32,
                            },
                            "token",
                            "/tmp/scope.pid",
                        )
                    )
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_removes_credential_file_when_subject_overrides_path(self):
        relay = load_relay()
        environment = Environment(stage_upload=True)
        token = f"contract-{uuid.uuid4().hex}"
        with tempfile.TemporaryDirectory() as directory:
            command = asyncio.run(
                relay._prepare_command(
                    environment,
                    {
                        "command": "/bin/sh",
                        "args": ["-c", "exit 0"],
                        "environment": {"PATH": "/definitely-missing"},
                        "credentials": {"API_KEY": "canary-secret"},
                        "captureStdout": True,
                        "resultToken": "0" * 32,
                    },
                    token,
                    str(Path(directory) / "scope.pid"),
                )
            )
            target = environment.uploaded_target
            self.assertIsNotNone(target)
            try:
                completed = subprocess.run(
                    ["/bin/sh", "-c", shlex.split(command)[-1]],
                    check=False,
                    capture_output=True,
                    text=True,
                )
                self.assertEqual(completed.returncode, 0, completed.stderr)
                self.assertFalse(target.exists())
            finally:
                target.unlink(missing_ok=True)


# Every default Docker capability except the two that bypass the policy.
CONSTRAINED_CAPABILITIES = 0xA80425FB & ~(1 << 13) & ~(1 << 12)
# The kernel's form for a namespace link target. Two distinct ones, because what
# the check compares is identity: the same string means the same namespace.
POLICY_NAMESPACE = "net:[4026532001]"
OWN_NAMESPACE = "net:[4026532099]"


class SubjectEnvironment:
    """Reports the evidence the probe reads: every `Cap` set, and both namespaces."""

    def __init__(
        self,
        *,
        permitted: int = CONSTRAINED_CAPABILITIES,
        effective: int | None = None,
        bounding: int | None = None,
        namespace: str = POLICY_NAMESPACE,
        default_user: str | None = None,
    ) -> None:
        self.sets = {
            "CapInh": 0,
            "CapPrm": permitted,
            "CapEff": permitted if effective is None else effective,
            "CapBnd": permitted if bounding is None else bounding,
            "CapAmb": 0,
        }
        self.namespace = namespace
        self.default_user = default_user
        self.commands: list[str] = []
        self.users: list[str | None] = []
        self.services: list[str] = []

    async def exec(self, command: str, cwd=None, env=None, timeout_sec=None, user=None):
        # Harbor 0.20.0 BaseEnvironment.exec takes user= as a named argument,
        # not **kwargs. Absorbing unknown keywords here would hide a TypeError
        # against the real Docker environment.
        self.commands.append(command)
        explicit = str(user) if user is not None else None
        self.users.append(explicit if explicit is not None else self.default_user)
        if "proxy-ipv4" in command:
            return types.SimpleNamespace(
                return_code=0,
                stdout="MAKA-EVAL-PROXY-HOST-V1 172.18.0.2 maka-eval-mitmproxy\n",
                stderr="",
            )
        reported = " ".join(f"{name}={value:016x}" for name, value in self.sets.items())
        return types.SimpleNamespace(
            return_code=0,
            stdout=(
                f"MAKA-EVAL-CAPABILITIES-V1 {reported}\n"
                f"MAKA-EVAL-POLICY-NAMESPACE-V1 {self.namespace}\n"
            ),
            stderr="",
        )

    async def service_exec(self, command: str, *, service: str, **kwargs):
        self.services.append(service)
        return types.SimpleNamespace(
            return_code=0,
            stdout=f"MAKA-EVAL-POLICY-NAMESPACE-V1 {POLICY_NAMESPACE}\n",
            stderr="",
        )


def _echoing_service_exec(answer: str):
    async def service_exec(command: str, *, service: str, **kwargs):
        return types.SimpleNamespace(
            return_code=0,
            stdout=f"MAKA-EVAL-POLICY-NAMESPACE-V1 {answer}\n",
            stderr="",
        )

    return service_exec


class SubjectCapabilityTest(unittest.IsolatedAsyncioTestCase):
    async def test_subject_holding_a_bypass_capability_never_starts(self):
        relay = load_relay()
        # Named here rather than read from the module: sourcing the expectation
        # from the code under test would let deleting a capability delete its
        # own coverage. NET_RAW grants AF_PACKET, NET_ADMIN grants `nft flush`.
        for name, bit in (("NET_RAW", 1 << 13), ("NET_ADMIN", 1 << 12)):
            with self.subTest(name):
                environment = SubjectEnvironment(permitted=bit | (1 << 21))
                with patch.dict(os.environ, {"MAKA_EVAL_EGRESS_REQUIRED": "1"}):
                    with self.assertRaises(RuntimeError) as raised:
                        await relay._require_constrained_subject(environment)
                self.assertIn(name, str(raised.exception))

    async def test_capability_reachable_only_through_the_bounding_set_never_starts(self):
        relay = load_relay()
        # A non-root subject reports an empty effective set while a
        # `cap_net_raw+ep` executable still reacquires whatever the bounding set
        # kept. Verified in a container: with the capability bounded away the
        # same executable cannot be run at all.
        environment = SubjectEnvironment(
            permitted=0,
            effective=0,
            bounding=CONSTRAINED_CAPABILITIES | (1 << 13),
        )
        with patch.dict(os.environ, {"MAKA_EVAL_EGRESS_REQUIRED": "1"}):
            with self.assertRaises(RuntimeError) as raised:
                await relay._require_constrained_subject(environment)
        self.assertIn("NET_RAW", str(raised.exception))

    async def test_subject_outside_the_policy_namespace_never_starts(self):
        relay = load_relay()
        # Harbor applies the policy inside the sidecar and respects a task's own
        # networking on `main`, so a task that declares it leaves the subject in
        # a namespace no policy was ever applied to.
        environment = SubjectEnvironment(namespace=OWN_NAMESPACE)
        with patch.dict(os.environ, {"MAKA_EVAL_EGRESS_REQUIRED": "1"}):
            with self.assertRaises(RuntimeError) as raised:
                await relay._require_constrained_subject(environment)
        self.assertIn("network namespace", str(raised.exception))

    async def test_policy_namespace_is_read_from_the_service_that_applies_the_policy(self):
        relay = load_relay()
        # The comparison is only meaningful against the namespace the policy was
        # installed in, and Harbor installs it by running `network-policy` in the
        # egress sidecar. Reading the other side from anywhere else would compare
        # the subject against a namespace nothing was applied to.
        environment = SubjectEnvironment()
        with patch.dict(os.environ, {"MAKA_EVAL_EGRESS_REQUIRED": "1"}):
            await relay._require_constrained_subject(environment)
        self.assertEqual(environment.services, ["harbor-docker-egress-control-sidecar"])

    async def test_constrained_subject_proceeds(self):
        relay = load_relay()
        with patch.dict(os.environ, {"MAKA_EVAL_EGRESS_REQUIRED": "1"}):
            await relay._require_constrained_subject(SubjectEnvironment())

    async def test_unreadable_evidence_fails_closed(self):
        relay = load_relay()

        class SilentEnvironment:
            async def exec(self, command, cwd=None, timeout_sec=None):
                return types.SimpleNamespace(return_code=0, stdout="", stderr="")

            async def service_exec(self, command, *, service, **kwargs):
                return types.SimpleNamespace(return_code=0, stdout="", stderr="")

        with patch.dict(os.environ, {"MAKA_EVAL_EGRESS_REQUIRED": "1"}):
            with self.assertRaises(RuntimeError):
                await relay._require_constrained_subject(SilentEnvironment())

    async def test_answer_that_is_not_a_namespace_identity_fails_closed(self):
        relay = load_relay()
        # Two sides that both failed to answer must not compare equal. Anything
        # that is not the kernel's own form is not an identity to compare.
        for answer in ("", "shared", "net:[]"):
            with self.subTest(answer):
                environment = SubjectEnvironment(namespace=answer)
                environment.service_exec = _echoing_service_exec(answer)
                with patch.dict(os.environ, {"MAKA_EVAL_EGRESS_REQUIRED": "1"}):
                    with self.assertRaises(RuntimeError):
                        await relay._require_constrained_subject(environment)

    async def test_check_is_scoped_to_runs_that_require_the_proxy(self):
        relay = load_relay()
        environment = SubjectEnvironment(permitted=1 << 13, namespace=OWN_NAMESPACE)
        with patch.dict(os.environ, {"MAKA_EVAL_EGRESS_REQUIRED": ""}):
            await relay._require_constrained_subject(environment)
        self.assertEqual(environment.commands, [])
        self.assertEqual(environment.services, [])

    async def test_missing_published_proxy_address_fails_closed(self):
        relay = load_relay()

        class MissingAddressEnvironment(SubjectEnvironment):
            async def exec(self, command, cwd=None, env=None, timeout_sec=None, user=None):
                if "proxy-ipv4" in command:
                    self.commands.append(command)
                    explicit = str(user) if user is not None else None
                    self.users.append(
                        explicit if explicit is not None else self.default_user
                    )
                    return types.SimpleNamespace(return_code=1, stdout="", stderr="")
                return await super().exec(
                    command, cwd=cwd, env=env, timeout_sec=timeout_sec, user=user
                )

        environment = MissingAddressEnvironment()
        with patch.dict(os.environ, {"MAKA_EVAL_EGRESS_REQUIRED": "1"}):
            with self.assertRaises(RuntimeError) as raised:
                await relay._require_constrained_subject(environment)
        self.assertIn("pin the Eval egress proxy hostname", str(raised.exception))
        pin_users = [
            user
            for command, user in zip(environment.commands, environment.users, strict=True)
            if "proxy-ipv4" in command
        ]
        self.assertEqual(pin_users, ["root"])

    async def test_proxy_hostname_pin_runs_as_root(self):
        relay = load_relay()
        environment = SubjectEnvironment()
        with patch.dict(os.environ, {"MAKA_EVAL_EGRESS_REQUIRED": "1"}):
            await relay._require_constrained_subject(environment)
        pin_users = [
            user
            for command, user in zip(environment.commands, environment.users, strict=True)
            if "proxy-ipv4" in command
        ]
        self.assertEqual(pin_users, ["root"])

    async def test_proxy_hostname_pin_does_not_inherit_a_non_root_default_user(self):
        # Harbor scopes every exec to the task's agent.user unless the call
        # names another identity. Pinning /etc/hosts is infrastructure, so it
        # must still be root when that default is a supported non-root user.
        relay = load_relay()
        environment = SubjectEnvironment(default_user="1000")
        with patch.dict(os.environ, {"MAKA_EVAL_EGRESS_REQUIRED": "1"}):
            await relay._require_constrained_subject(environment)
        probe_users = [
            user
            for command, user in zip(environment.commands, environment.users, strict=True)
            if "proxy-ipv4" not in command
        ]
        pin_users = [
            user
            for command, user in zip(environment.commands, environment.users, strict=True)
            if "proxy-ipv4" in command
        ]
        self.assertEqual(probe_users, ["1000"])
        self.assertEqual(pin_users, ["root"])

    async def test_invalid_proxy_hostname_is_rejected_before_hosts_rewrite(self):
        relay = load_relay()
        for host in (
            ".*",
            "proxy*",
            "evil.com\n127.0.0.1 pwned",
            "foo bar",
            "foo..bar",
            ".hidden",
            "maka-évál",
        ):
            with self.subTest(host=host):
                environment = SubjectEnvironment()
                with patch.dict(os.environ, {"MAKA_EVAL_EGRESS_ALLOWED_HOST": host}):
                    with self.assertRaisesRegex(RuntimeError, "proxy host is invalid"):
                        await relay._pin_proxy_hostname(environment)
                self.assertEqual(environment.commands, [])

    async def test_proxy_hostname_pin_matches_hosts_aliases_exactly(self):
        relay = load_relay()
        environment = SubjectEnvironment()
        with patch.dict(os.environ, {"MAKA_EVAL_EGRESS_REQUIRED": "1"}):
            await relay._require_constrained_subject(environment)
        pin = next(command for command in environment.commands if "proxy-ipv4" in command)
        self.assertIn(relay.HOSTS_ALIAS_AWK, pin)

        completed = subprocess.run(
            ["awk", "-v", "host=maka-eval-mitmproxy", relay.HOSTS_ALIAS_AWK],
            input=(
                "127.0.0.1 localhost\n"
                "10.0.0.1 maka-eval-mitmproxy extra\n"
                "10.0.0.2 prefix-maka-eval-mitmproxy\n"
                "10.0.0.3 other.example\n"
                "10.0.0.4 other.example maka-eval-mitmproxy\n"
            ),
            check=True,
            capture_output=True,
            text=True,
        )
        self.assertEqual(
            completed.stdout,
            "127.0.0.1 localhost\n"
            "10.0.0.2 prefix-maka-eval-mitmproxy\n"
            "10.0.0.3 other.example\n",
        )

    def test_harbor_0_20_0_exec_declares_user_as_a_named_parameter(self):
        # Harbor 0.20.0 BaseEnvironment.exec / DockerEnvironment.exec:
        #   (command, cwd=None, env=None, timeout_sec=None, user=None)
        # A **kwargs-only double would absorb user= and hide a TypeError
        # against that signature.
        parameter = inspect.signature(SubjectEnvironment.exec).parameters["user"]
        self.assertNotEqual(parameter.kind, inspect.Parameter.VAR_KEYWORD)
        inspect.signature(SubjectEnvironment.exec).bind(
            None, "true", user="root"
        )

    def test_published_ipv4_requires_four_0_255_octets(self):
        relay = load_relay()
        accepted = ("172.18.0.2", "0.1.2.3", "255.255.255.255", "10.0.0.1")
        rejected = (
            "999.1.1.1",
            "1.2.3",
            "1..2.3",
            "1.2.3.4.5",
            "01.2.3.4",
            "1.2.3.08",
            "...",
            "",
            "172.18.0.2/32",
            "localhost",
        )
        for ip in accepted:
            with self.subTest(ip=ip):
                self.assertTrue(relay._valid_published_ipv4(ip))
        for ip in rejected:
            with self.subTest(ip=ip):
                self.assertFalse(relay._valid_published_ipv4(ip))

        for ip in (*accepted, *rejected):
            with self.subTest(awk=ip):
                completed = subprocess.run(
                    ["awk", relay.IPV4_OCTET_AWK],
                    input=f"{ip}\n",
                    capture_output=True,
                    text=True,
                )
                self.assertEqual(
                    completed.returncode == 0,
                    relay._valid_published_ipv4(ip),
                    ip,
                )

    def test_network_policy_uses_the_same_ipv4_octet_check(self):
        relay = load_relay()
        policy = Path(__file__).with_name("egress-proxy").joinpath("network-policy")
        self.assertIn(relay.IPV4_OCTET_AWK.strip(), policy.read_text())

    def test_network_policy_rejects_docker_dns_before_local_accept(self):
        policy = Path(__file__).with_name("egress-proxy").joinpath("network-policy").read_text()
        reject = policy.index("ip daddr 127.0.0.11 reject")
        local = policy.index("fib daddr type local accept")
        self.assertLess(reject, local)

    async def test_malformed_published_proxy_address_fails_closed(self):
        relay = load_relay()

        class BadAddressEnvironment(SubjectEnvironment):
            async def exec(self, command, cwd=None, env=None, timeout_sec=None, user=None):
                if "proxy-ipv4" in command:
                    self.commands.append(command)
                    explicit = str(user) if user is not None else None
                    self.users.append(
                        explicit if explicit is not None else self.default_user
                    )
                    return types.SimpleNamespace(
                        return_code=0,
                        stdout="MAKA-EVAL-PROXY-HOST-V1 999.1.1.1 maka-eval-mitmproxy\n",
                        stderr="",
                    )
                return await super().exec(
                    command, cwd=cwd, env=env, timeout_sec=timeout_sec, user=user
                )

        with patch.dict(os.environ, {"MAKA_EVAL_EGRESS_REQUIRED": "1"}):
            with self.assertRaises(RuntimeError) as raised:
                await relay._require_constrained_subject(BadAddressEnvironment())
        self.assertIn("pin the Eval egress proxy hostname", str(raised.exception))


class FrameworkSelectionTest(unittest.TestCase):
    def test_relay_loads_harbor_and_pier_from_the_installed_selection(self):
        for framework in ("harbor", "pier"):
            with self.subTest(framework):
                relay = load_relay(framework)
                self.assertEqual(relay.framework, framework)

    def test_relay_does_not_select_a_framework_from_the_environment(self):
        os.environ["MAKA_EVAL_FRAMEWORK"] = "pier"
        relay = load_relay("harbor")
        self.assertEqual(relay.framework, "harbor")


if __name__ == "__main__":
    unittest.main()
