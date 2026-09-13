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

"""Prove the cell namespace forces subject egress through the audited proxy.

The Python policy test only checks that `run_trial.py` hands Harbor the right
allowlist. This test brings up the checked-in Compose overlay against a minimal
Harbor-shaped base, applies the checked-in `network-policy` from a sidecar that
shares the subject namespace, and asserts what the README promises: explicit
proxy traffic works, everything else does not, and the subject never sees the
CA private key or the audit log.

It needs a working Docker daemon and outbound network, so it is opt-in:

    MAKA_EVAL_EGRESS_NAMESPACE_TEST=1 python3 harbor/test_cell_egress_namespace.py
"""

from __future__ import annotations

import asyncio
import os
import shutil
import subprocess
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

from test_relay_contract import load_relay

HARBOR_DIR = Path(__file__).parent
OVERLAY = HARBOR_DIR / "docker-compose-egress-proxy.yaml"
NETWORK_POLICY = HARBOR_DIR / "egress-proxy" / "network-policy"
PROXY_IMAGE = "maka-eval-egress-proxy:12.2.3"
MAIN_IMAGE = "maka-eval-egress-namespace-main:test"
SIDECAR_IMAGE = "maka-eval-egress-namespace-sidecar:test"
PROJECT = "maka-eval-egress-namespace-test"
PROXY_HOST = "maka-eval-mitmproxy"
SIDECAR = "harbor-docker-egress-control-sidecar"
OUTSIDER = "maka-eval-outside-the-namespace"
BOUNDED = "maka-eval-bounded-capability"
CA_PATH = "/opt/maka-egress/mitmproxy-ca-cert.pem"
BUILD_TIMEOUT_S = 900
COMMAND_TIMEOUT_S = 120

BASE_COMPOSE = f"""\
services:
  main:
    image: {MAIN_IMAGE}
    command: ["sleep", "infinity"]

  {SIDECAR}:
    image: {SIDECAR_IMAGE}
    # Harbor's own sidecar runs gost on the port the policy redirects to, so a
    # redirected connection is accepted and then goes nowhere. Standing in for
    # it keeps the negative assertions honest: without a listener they would
    # hold on a refused connection instead of on the policy.
    command: ["sh", "-c", "nc -l -k 12345 >/dev/null 2>&1 & exec sleep infinity"]
    network_mode: "service:main"
    cap_add:
      - NET_ADMIN
    depends_on:
      - main

  # Two services the gate must refuse, so its live coverage is not only the
  # positive case. This one keeps its own network namespace, the way Harbor
  # leaves a subject whose task declares its own networking.
  {OUTSIDER}:
    image: {MAIN_IMAGE}
    command: ["sleep", "infinity"]
    cap_drop:
      - NET_RAW

  # This one shares the policy's namespace and reports an empty effective set,
  # while the bounding set still lets a file-capability executable take NET_RAW
  # back. Reading only the effective set would admit it.
  {BOUNDED}:
    image: {MAIN_IMAGE}
    command: ["sleep", "infinity"]
    network_mode: "service:main"
    user: "1000"
    depends_on:
      - main
"""

MAIN_DOCKERFILE = """\
FROM python:3.12-slim
RUN apt-get update \\
  && apt-get install -y --no-install-recommends ca-certificates curl iputils-ping \\
  && rm -rf /var/lib/apt/lists/*
"""

# Debian bookworm ships nftables 1.0.6, which rejects the `dstnat` priority name
# on a nat output chain; the policy needs 1.1 or newer, as Harbor's sidecar has.
SIDECAR_DOCKERFILE = """\
FROM debian:trixie-slim
RUN apt-get update \\
  && apt-get install -y --no-install-recommends nftables netcat-openbsd \\
  && rm -rf /var/lib/apt/lists/* \\
  && mkdir -p /opt/egress-sidecar
"""

# The policy redirects TCP to the sidecar's proxy port rather than dropping it,
# so the connection still completes and only the response tells a direct route
# from a redirected one. Judging this on `connect` would assert nothing in a
# cell where that proxy is listening, which is every real one.
TCP_PROBE = (
    "import socket\n"
    "request = b'GET / HTTP/1.0\\r\\nHost: one.one.one.one\\r\\n\\r\\n'\n"
    "try:\n"
    "    with socket.create_connection(('1.1.1.1', 80), 5) as sock:\n"
    "        sock.settimeout(5)\n"
    "        sock.sendall(request)\n"
    "        print('reachable' if sock.recv(16).startswith(b'HTTP/') else 'blocked')\n"
    "except OSError:\n"
    "    print('blocked')\n"
)

# A well-formed query for example.com. A malformed datagram is dropped without a
# reply even by a reachable resolver, which would report the open network as
# blocked and silently retire this probe's assertion.
UDP_PROBE = (
    "import socket\n"
    "query = (\n"
    "    b'\\xab\\xcd\\x01\\x00\\x00\\x01\\x00\\x00\\x00\\x00\\x00\\x00'\n"
    "    b'\\x07example\\x03com\\x00\\x00\\x01\\x00\\x01'\n"
    ")\n"
    "sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)\n"
    "sock.settimeout(5)\n"
    "try:\n"
    "    sock.sendto(query, ('8.8.8.8', 53))\n"
    "    sock.recvfrom(512)\n"
    "    print('reachable')\n"
    "except OSError:\n"
    "    print('blocked')\n"
)

DOCKER_DNS_PROBE = (
    "import socket\n"
    "query = (\n"
    "    b'\\xab\\xcd\\x01\\x00\\x00\\x01\\x00\\x00\\x00\\x00\\x00\\x00'\n"
    "    b'\\x07example\\x03com\\x00\\x00\\x01\\x00\\x01'\n"
    ")\n"
    "sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)\n"
    "sock.settimeout(5)\n"
    "try:\n"
    "    sock.sendto(query, ('127.0.0.11', 53))\n"
    "    sock.recvfrom(512)\n"
    "    print('reachable')\n"
    "except OSError:\n"
    "    print('blocked')\n"
)

# An AF_PACKET socket writes at the link layer, below the IP output hooks the
# policy installs, so no nftables rule can see this traffic at all. Only the
# absence of NET_RAW stops it. The frame is addressed to the default gateway's
# hardware address, which the pre-policy reachability assertions leave in the
# neighbour table.
PACKET_PROBE = (
    "import socket, struct\n"
    "query = (\n"
    "    b'\\xab\\xcd\\x01\\x00\\x00\\x01\\x00\\x00\\x00\\x00\\x00\\x00'\n"
    "    b'\\x07example\\x03com\\x00\\x00\\x01\\x00\\x01'\n"
    ")\n"
    "def route():\n"
    "    with open('/proc/net/route') as handle:\n"
    "        for line in handle.readlines()[1:]:\n"
    "            f = line.split()\n"
    "            if f[1] == '00000000':\n"
    "                return f[0], socket.inet_ntoa(struct.pack('<L', int(f[2], 16)))\n"
    "    return None, None\n"
    "def neighbour(address):\n"
    "    with open('/proc/net/arp') as handle:\n"
    "        for line in handle.readlines()[1:]:\n"
    "            f = line.split()\n"
    "            if f[0] == address and f[3] != '00:00:00:00:00:00':\n"
    "                return bytes.fromhex(f[3].replace(':', ''))\n"
    "    return None\n"
    "def checksum(data):\n"
    "    total = sum(struct.unpack('!%dH' % (len(data) // 2), data))\n"
    "    while total >> 16:\n"
    "        total = (total & 0xFFFF) + (total >> 16)\n"
    "    return ~total & 0xFFFF\n"
    "interface, gateway = route()\n"
    "mac = neighbour(gateway) if gateway else None\n"
    "if not interface or not mac:\n"
    "    print('unusable')\n"
    "else:\n"
    "    try:\n"
    "        sock = socket.socket(socket.AF_PACKET, socket.SOCK_DGRAM, 0x0800)\n"
    "    except PermissionError:\n"
    "        print('denied')\n"
    "        raise SystemExit\n"
    "    try:\n"
    "        source = socket.gethostbyname(socket.gethostname())\n"
    "        sock.bind((interface, 0x0800))\n"
    "        sock.settimeout(5)\n"
    "        udp = struct.pack('!HHHH', 40000, 53, 8 + len(query), 0) + query\n"
    "        header = struct.pack(\n"
    "            '!BBHHHBBH4s4s', 0x45, 0, 20 + len(udp), 0x1234, 0, 64, 17, 0,\n"
    "            socket.inet_aton(source), socket.inet_aton('8.8.8.8'),\n"
    "        )\n"
    "        header = header[:10] + struct.pack('!H', checksum(header)) + header[12:]\n"
    "        sock.sendto(header + udp, (interface, 0x0800, 0, 0, mac))\n"
    "        while True:\n"
    "            packet = sock.recv(2048)\n"
    "            if len(packet) >= 20 and packet[12:16] == socket.inet_aton('8.8.8.8'):\n"
    "                print('reachable')\n"
    "                break\n"
    "    except OSError:\n"
    "        print('blocked')\n"
)

LOOPBACK_PROBE = (
    "import socket\n"
    "server = socket.socket()\n"
    "server.bind(('127.0.0.1', 0))\n"
    "server.listen(1)\n"
    "client = socket.create_connection(server.getsockname(), 5)\n"
    "client.close()\n"
    "print('reachable')\n"
)

PROXY_ENVIRONMENT = {
    "HTTPS_PROXY": f"http://{PROXY_HOST}:8080",
    "CURL_CA_BUNDLE": CA_PATH,
}

# The bypass attempt carries no CA override: pinning trust to the cell CA would
# fail a successful direct connection on certificate verification instead, and
# the assertion would hold even with the policy removed.
BYPASS_ENVIRONMENT = {"HTTPS_PROXY": f"http://{PROXY_HOST}:8080"}


def docker_available() -> bool:
    if shutil.which("docker") is None:
        return False
    probe = subprocess.run(
        ["docker", "version", "--format", "{{.Server.Version}}"],
        capture_output=True,
        timeout=COMMAND_TIMEOUT_S,
    )
    return probe.returncode == 0


@unittest.skipUnless(
    os.environ.get("MAKA_EVAL_EGRESS_NAMESPACE_TEST") == "1",
    "set MAKA_EVAL_EGRESS_NAMESPACE_TEST=1 to run the Docker cell namespace test",
)
class CellEgressNamespaceTest(unittest.TestCase):
    workdir: Path | None = None
    compose: list[str] = []

    @classmethod
    def setUpClass(cls) -> None:
        if not docker_available():
            raise unittest.SkipTest("Docker daemon is unavailable")
        cls.workdir = Path(tempfile.mkdtemp(prefix="maka-eval-egress-namespace-"))
        # Registered before anything can fail: `tearDownClass` does not run when
        # `setUpClass` raises, which would leak the stack and the named volume.
        cls.addClassCleanup(shutil.rmtree, cls.workdir, ignore_errors=True)
        (cls.workdir / "base.yaml").write_text(BASE_COMPOSE)
        cls.build_image(MAIN_IMAGE, dockerfile=MAIN_DOCKERFILE, name="main")
        cls.build_image(SIDECAR_IMAGE, dockerfile=SIDECAR_DOCKERFILE, name="sidecar")
        cls.build_image(
            PROXY_IMAGE, context=HARBOR_DIR, path=HARBOR_DIR / "egress-proxy" / "Dockerfile"
        )
        cls.compose = [
            "docker",
            "compose",
            "--project-name",
            PROJECT,
            "--file",
            str(cls.workdir / "base.yaml"),
            "--file",
            str(OVERLAY),
        ]
        cls.run_compose(["down", "--volumes", "--remove-orphans"], check=False)
        cls.addClassCleanup(
            cls.run_compose, ["down", "--volumes", "--remove-orphans"], check=False
        )
        cls.run_compose(["up", "--detach", "--wait"], timeout=BUILD_TIMEOUT_S)
        # Pin the proxy hostname before any test applies the policy, so
        # HTTPS_PROXY still resolves after Docker DNS is refused.
        asyncio.run(load_relay()._pin_proxy_hostname(CellEnvironment("main")))

    @classmethod
    def build_image(
        cls,
        tag: str,
        *,
        dockerfile: str | None = None,
        name: str | None = None,
        context: Path | None = None,
        path: Path | None = None,
    ) -> None:
        if dockerfile is not None:
            context = cls.workdir / name
            context.mkdir()
            (context / "Dockerfile").write_text(dockerfile)
        subprocess.run(
            [
                "docker",
                "build",
                "--tag",
                tag,
                *(["--file", str(path)] if path else []),
                str(context),
            ],
            check=True,
            timeout=BUILD_TIMEOUT_S,
        )

    @classmethod
    def run_compose(
        cls,
        arguments: list[str],
        *,
        check: bool = True,
        timeout: int = COMMAND_TIMEOUT_S,
    ) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [*cls.compose, *arguments],
            env={**os.environ, "MAKA_EVAL_NETWORK_POLICY_PATH": str(NETWORK_POLICY)},
            capture_output=True,
            text=True,
            check=check,
            timeout=timeout,
        )

    @classmethod
    def exec_service(
        cls,
        service: str,
        command: list[str],
        *,
        environment: dict[str, str] | None = None,
        user: str | None = None,
    ) -> subprocess.CompletedProcess[str]:
        overrides = [
            argument
            for name, value in (environment or {}).items()
            for argument in ("--env", f"{name}={value}")
        ]
        user_args = ["--user", user] if user else []
        return cls.run_compose(
            ["exec", "--no-TTY", *user_args, *overrides, service, *command], check=False
        )

    @classmethod
    def exec_main(
        cls, command: list[str], *, environment: dict[str, str] | None = None
    ) -> subprocess.CompletedProcess[str]:
        return cls.exec_service("main", command, environment=environment)

    @classmethod
    def probe_main(cls, script: str) -> str:
        result = cls.exec_main(["python3", "-c", script])
        if result.returncode != 0:
            raise AssertionError(f"probe failed to run: {result.stderr}")
        return result.stdout.strip()

    @classmethod
    def curl(
        cls, arguments: list[str], *, environment: dict[str, str] | None = None
    ) -> subprocess.CompletedProcess[str]:
        return cls.exec_main(
            [
                "curl",
                "--silent",
                "--show-error",
                "--max-time",
                "20",
                "--output",
                "/dev/null",
                *arguments,
                "https://example.com",
            ],
            environment=environment,
        )

    @classmethod
    def ping(cls) -> subprocess.CompletedProcess[str]:
        return cls.exec_main(["ping", "-c", "1", "-W", "5", "1.1.1.1"])

    def test_no_network_phase_is_not_answered_with_proxy_access(self) -> None:
        # Harbor's deny-all denies controlled egress outright, so answering it
        # with the proxy-only ruleset would grant a phase that asked for no
        # network a route this override invented.
        reachable = self.curl([], environment=PROXY_ENVIRONMENT)
        self.assertEqual(reachable.returncode, 0, reachable.stderr)
        try:
            denied = self.exec_service(SIDECAR, ["network-policy", "deny-all"])
            self.assertEqual(denied.returncode, 0, denied.stderr)
            blocked = self.curl([], environment=PROXY_ENVIRONMENT)
            self.assertNotEqual(blocked.returncode, 0)
        finally:
            restored = self.exec_service(SIDECAR, ["network-policy", "allow", PROXY_HOST])
            self.assertEqual(restored.returncode, 0, restored.stderr)

    def test_relay_admits_only_a_subject_the_policy_governs(self) -> None:
        # The gate runs against live containers rather than a fixture, so what
        # it parses is a real `/proc` and what it judges is a real namespace.
        # The refusals matter more than the admission: without them nothing
        # would catch a probe that reports one constant answer.
        relay = load_relay()
        with patch.dict(os.environ, {"MAKA_EVAL_EGRESS_REQUIRED": "1"}):
            asyncio.run(relay._require_constrained_subject(CellEnvironment("main")))
            with self.assertRaises(RuntimeError) as outside:
                asyncio.run(relay._require_constrained_subject(CellEnvironment(OUTSIDER)))
            with self.assertRaises(RuntimeError) as bounded:
                asyncio.run(relay._require_constrained_subject(CellEnvironment(BOUNDED)))
        self.assertIn("network namespace", str(outside.exception))
        self.assertIn("NET_RAW", str(bounded.exception))

    def test_subject_sees_only_the_ca_certificate(self) -> None:
        listed = self.exec_main(["ls", "--almost-all", "/opt/maka-egress"])
        self.assertEqual(listed.returncode, 0, listed.stderr)
        self.assertEqual(sorted(listed.stdout.split()), ["mitmproxy-ca-cert.pem", "proxy-ipv4"])

    def test_cell_namespace_admits_only_the_audited_proxy(self) -> None:
        # Every negative assertion below is vacuous on a host that cannot reach
        # the target anyway, so the reachability of each one is asserted before
        # the policy exists. Failing there is the point: a skip would report a
        # contract this run never actually exercised.
        self.assertEqual(self.curl([]).returncode, 0, "no HTTPS before any policy")
        self.assertEqual(self.probe_main(TCP_PROBE), "reachable")
        self.assertEqual(self.probe_main(UDP_PROBE), "reachable")
        self.assertEqual(self.probe_main(DOCKER_DNS_PROBE), "reachable")
        self.assertEqual(self.ping().returncode, 0, "no ICMP before any policy")

        applied = self.exec_service(
            SIDECAR, ["network-policy", "allow", PROXY_HOST]
        )
        self.assertEqual(applied.returncode, 0, applied.stderr)

        with self.subTest("explicit proxy HTTPS"):
            allowed = self.curl([], environment=PROXY_ENVIRONMENT)
            self.assertEqual(allowed.returncode, 0, allowed.stderr)

        with self.subTest("curl --noproxy"):
            bypassed = self.curl(["--noproxy", "*"], environment=BYPASS_ENVIRONMENT)
            self.assertNotEqual(bypassed.returncode, 0)

        with self.subTest("direct IP TCP"):
            self.assertEqual(self.probe_main(TCP_PROBE), "blocked")

        # Not preceded by a reachability assertion like the others: this path is
        # closed by the missing capability rather than by the policy, so it is
        # already shut before the policy exists. `denied` rather than `blocked`
        # so a probe that breaks for any other reason cannot report success.
        with self.subTest("link-layer AF_PACKET"):
            self.assertEqual(self.probe_main(PACKET_PROBE), "denied")

        with self.subTest("external UDP"):
            self.assertEqual(self.probe_main(UDP_PROBE), "blocked")

        with self.subTest("external ICMP"):
            self.assertNotEqual(self.ping().returncode, 0)

        with self.subTest("loopback provider proxy"):
            self.assertEqual(self.probe_main(LOOPBACK_PROBE), "reachable")

        with self.subTest("pinned proxy hostname"):
            resolved = self.exec_main(["getent", "hosts", PROXY_HOST])
            self.assertEqual(resolved.returncode, 0, resolved.stderr)

        with self.subTest("Docker DNS"):
            self.assertEqual(self.probe_main(DOCKER_DNS_PROBE), "blocked")

class CellEnvironment:
    """Presents one live cell service as the relay's environment."""

    def __init__(self, service: str) -> None:
        self.service = service

    async def exec(self, command: str, cwd=None, env=None, timeout_sec=None, user=None):
        return self._run(
            self.service, command, user=str(user) if user is not None else None
        )

    async def service_exec(self, command: str, *, service: str, **kwargs):
        return self._run(service, command)

    @staticmethod
    def _run(service: str, command: str, user: str | None = None):
        result = CellEgressNamespaceTest.exec_service(
            service, ["sh", "-c", command], user=user
        )
        return types.SimpleNamespace(
            return_code=result.returncode, stdout=result.stdout, stderr=result.stderr
        )


if __name__ == "__main__":
    unittest.main()
