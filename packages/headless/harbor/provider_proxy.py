"""Host provider proxy endpoint parsing shared by the proxied CLI adapters.

The Kimi Code and Codex adapters run a pinned CLI inside the task container
that dials the host provider auth proxy (MAKA_PROVIDER_PROXY_URL). Under Pier
that proxy host is the single egress domain each adapter must allowlist, so
the endpoint-shape rules live here once.
"""

from __future__ import annotations

import sys
from typing import Callable
from urllib.parse import urlparse


def provider_proxy_endpoint(
    get_env: Callable[[str], str | None], agent_label: str
) -> tuple[str, int | None]:
    """Hostname and port of MAKA_PROVIDER_PROXY_URL for the Pier allowlist.

    Pier-only validation, called from network_allowlist() after its plain-
    Harbor early return: Pier's NetworkAllowlist domain validator rejects
    ':' entries, so an IPv6 literal endpoint can never be allowlisted.
    Plain Harbor forwards the URL opaquely to the CLI and must not have its
    input domain narrowed by this Pier constraint.
    """
    proxy_url = get_env("MAKA_PROVIDER_PROXY_URL")
    if not proxy_url:
        raise ValueError(f"{agent_label} requires the host provider proxy")
    try:
        parsed = urlparse(proxy_url if "://" in proxy_url else f"https://{proxy_url}")
        hostname = parsed.hostname
        port = parsed.port
    except ValueError as error:
        raise ValueError(f"{agent_label} requires the host provider proxy") from error
    if not hostname:
        raise ValueError(f"{agent_label} requires the host provider proxy")
    if ":" in hostname:
        raise ValueError(
            f"{agent_label} provider proxy must use a DNS hostname or IPv4 "
            "address; IPv6 literal endpoints are not supported"
        )
    return hostname, port


def warn_if_pier_unreachable_proxy_port(port: int | None, agent_label: str) -> None:
    """Warn when the proxy port cannot pass Pier's offline-task egress.

    Pier's egress proxy for allow_internet=false tasks is Squid with
    `acl Safe_ports port 80 443` + `http_access deny !Safe_ports`
    (pier/environments/agent_setup.py), so any other destination port is
    denied even when the domain is allowlisted. Warn instead of raising: the
    adapter cannot see the task's allow_internet, and on internet-enabled
    tasks the allowlist is ignored and this port is legal.
    """
    if port not in (None, 80, 443):
        print(
            f"WARNING: {agent_label} provider proxy port {port} is unreachable "
            "under Pier non-internet tasks: the Squid egress proxy only "
            "allows destination ports 80 and 443. Bind the provider proxy "
            "to 80/443 or use an internet-enabled task.",
            file=sys.stderr,
        )
