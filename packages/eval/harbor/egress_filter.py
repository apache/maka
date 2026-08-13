"""Fail-closed URL contamination filter for Eval subject egress."""

from __future__ import annotations

import json
import os
import re
import time
from pathlib import Path
from urllib.parse import unquote, urlsplit

PINNED_REVISION = "d49e28f1e4ddd13d289e85a5f312a66750951932"
MAX_DECODE_PASSES = 4
MAX_AUDIT_BYTES = 1024 * 1024
AUDIT_PATH = Path(os.environ.get("MAKA_EVAL_EGRESS_AUDIT", "/opt/maka-egress/hits.jsonl"))
PERCENT_ESCAPE = re.compile(r"%(?![0-9a-fA-F]{2})")
TERMINAL_BENCH = re.compile(r"terminal[-_.%/+\s]*bench", re.IGNORECASE)


def contamination_rule(raw_url: str) -> tuple[str, str, str] | None:
    normalized = normalize_url(raw_url)
    url = urlsplit(normalized)
    host = (url.hostname or "").lower().rstrip(".")
    path_query = f"{url.path}?{url.query}" if url.query else url.path
    lowered = path_query.lower()

    if host == "r.jina.ai":
        inner = unquote(url.path.lstrip("/"))
        if inner.startswith(("http://", "https://")):
            nested = contamination_rule(inner)
            if nested:
                return (f"jina_recursive:{nested[0]}", host, path_query)

    if PINNED_REVISION in lowered:
        return ("pinned_revision", host, path_query)
    if host == "tbench.ai":
        return ("tbench_domain", host, path_query)
    if host == "hub.harborframework.com" and "/tasks/terminal-bench" in lowered:
        return ("harbor_task_registry", host, path_query)
    if benchmark_repository(host, lowered):
        return ("benchmark_repository", host, path_query)
    if public_trajectory_repository(host, lowered):
        return ("public_trajectory", host, path_query)
    if "patches-terminalbench-" in lowered:
        return ("known_patch_artifact", host, path_query)
    if TERMINAL_BENCH.search(lowered):
        return ("terminal_bench_url", host, path_query)
    return None


def normalize_url(raw_url: str) -> str:
    value = raw_url.strip()
    if not value:
        raise ValueError("empty URL")
    for _ in range(MAX_DECODE_PASSES):
        if PERCENT_ESCAPE.search(value):
            raise ValueError("malformed percent escape")
        decoded = unquote(value)
        if decoded == value:
            break
        value = decoded
    else:
        raise ValueError("URL exceeded decode limit")
    parsed = urlsplit(value)
    if parsed.scheme.lower() not in {"http", "https"} or not parsed.hostname:
        raise ValueError("unsupported URL")
    return value


def benchmark_repository(host: str, path_query: str) -> bool:
    repositories = (
        "harbor-framework/terminal-bench",
        "terminal-benchmarks/terminal-bench",
        "tbench-ai/terminal-bench",
    )
    return host in {
        "github.com",
        "api.github.com",
        "raw.githubusercontent.com",
        "codeload.github.com",
    } and any(repository in path_query for repository in repositories)


def public_trajectory_repository(host: str, path_query: str) -> bool:
    return (
        host in {"github.com", "api.github.com", "raw.githubusercontent.com", "huggingface.co"}
        and "hqeric/maka-eval-trajectories" in path_query
    )


try:
    from mitmproxy import http
except ImportError:
    http = None


def request(flow: object) -> None:
    if http is None:
        raise RuntimeError("mitmproxy is required to run the Eval egress filter")
    try:
        matched = contamination_rule(flow.request.pretty_url)
        if not matched:
            return
        rule_id, host, normalized_path = matched
        append_audit(rule_id, host, normalized_path)
        flow.response = blocked_response(rule_id)
    except Exception as error:
        flow.response = http.Response.make(
            503,
            b"Eval egress policy could not classify this request.\n",
            {
                "Content-Type": "text/plain; charset=utf-8",
                "X-Maka-Eval-Egress-Rule": "policy_error",
            },
        )
        try:
            append_audit("policy_error", "", type(error).__name__)
        except Exception:
            pass


def blocked_response(rule_id: str):
    return http.Response.make(
        451,
        b"Benchmark source or public solution access is blocked during evaluation.\n",
        {
            "Content-Type": "text/plain; charset=utf-8",
            "X-Maka-Eval-Egress-Rule": rule_id,
        },
    )


def append_audit(rule_id: str, host: str, normalized_path: str) -> None:
    AUDIT_PATH.parent.mkdir(parents=True, exist_ok=True)
    if AUDIT_PATH.exists() and AUDIT_PATH.stat().st_size >= MAX_AUDIT_BYTES:
        return
    record = {
        "ts": int(time.time() * 1000),
        "ruleId": rule_id,
        "host": host[:255],
        "normalizedPath": normalized_path[:4096],
    }
    with AUDIT_PATH.open("a", encoding="utf-8") as stream:
        stream.write(json.dumps(record, ensure_ascii=True, separators=(",", ":")) + "\n")
