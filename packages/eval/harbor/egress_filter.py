"""Path-level egress filter for Terminal-Bench evaluation subjects."""

from __future__ import annotations

from urllib.parse import unquote, urlsplit

BLOCKED_OWNERS = {"harbor-framework", "nousresearch"}


def blocked_terminal_bench_url(raw_url: str) -> bool:
    try:
        url = urlsplit(raw_url)
    except ValueError:
        return False
    host = (url.hostname or "").lower().rstrip(".")
    segments = [unquote(part).lower() for part in url.path.split("/") if part]
    if host == "api.github.com":
        return (
            len(segments) >= 3
            and segments[0] == "repos"
            and blocked_repository(segments[1], segments[2])
        )
    if host in {"github.com", "raw.githubusercontent.com", "codeload.github.com"}:
        return len(segments) >= 2 and blocked_repository(segments[0], segments[1])
    return False


def blocked_repository(owner: str, repository: str) -> bool:
    return owner.lower() in BLOCKED_OWNERS and repository.lower().startswith("terminal-bench")


try:
    from mitmproxy import http
except ImportError:
    http = None


def request(flow: object) -> None:
    if http is None:
        raise RuntimeError("mitmproxy is required to run the Eval egress filter")
    request_url = flow.request.pretty_url
    if not blocked_terminal_bench_url(request_url):
        return
    flow.response = http.Response.make(
        451,
        b"Terminal-Bench benchmark source access is blocked during evaluation.\n",
        {"Content-Type": "text/plain; charset=utf-8"},
    )
