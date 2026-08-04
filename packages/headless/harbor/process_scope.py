"""Process-scope helpers shared by Harbor agent adapters."""

from __future__ import annotations

import asyncio
import shlex
from typing import Any


COMMAND_SCOPE_ENV = "MAKA_HARBOR_COMMAND_SCOPE"
COMMAND_ID_ENV = "MAKA_HARBOR_COMMAND_ID"
COMMAND_SCOPE_ROOT = "/tmp/maka-harbor-command-scopes"


async def cleanup_process_scope(
    agent: Any, environment: Any, scope: str
) -> None:
    first_error: BaseException | None = None
    try:
        await agent.exec_as_agent(
            environment,
            command=scoped_process_cleanup_command(scope, "TERM"),
        )
    except BaseException as error:
        first_error = error
    await asyncio.sleep(0.2)
    try:
        await agent.exec_as_agent(
            environment,
            command=scoped_process_cleanup_command(scope, "KILL"),
        )
    except BaseException as error:
        if first_error is None:
            first_error = error
    if first_error is not None:
        raise first_error


def scoped_command(command: str, scope: str, command_id: str) -> str:
    scope_dir = shlex.quote(f"{COMMAND_SCOPE_ROOT}/{scope}")
    pgid_path = shlex.quote(f"{COMMAND_SCOPE_ROOT}/{scope}/{command_id}.pgid")
    wrapper_path = shlex.quote(f"{COMMAND_SCOPE_ROOT}/{scope}/{command_id}.wrapper")
    stdout_path = shlex.quote(f"{COMMAND_SCOPE_ROOT}/{scope}/{command_id}.stdout")
    stderr_path = shlex.quote(f"{COMMAND_SCOPE_ROOT}/{scope}/{command_id}.stderr")
    return (
        f"mkdir -p -- {scope_dir}; printf '%s\\n' \"$$\" > {wrapper_path}; set -m; "
        f"env {COMMAND_SCOPE_ENV}={shlex.quote(scope)} "
        f"{COMMAND_ID_ENV}={shlex.quote(command_id)} "
        f"bash -lc {shlex.quote(command)} > {stdout_path} 2> {stderr_path} & "
        "command_pid=$!; "
        "set +m; "
        f"printf '%s\\n' \"$command_pid\" > {pgid_path}; "
        "wait \"$command_pid\" 2>/dev/null; command_status=$?; "
        f"cat -- {stdout_path}; cat -- {stderr_path} >&2; "
        f"rm -f -- {stdout_path} {stderr_path}; "
        f"kill -0 -- \"-$command_pid\" 2>/dev/null || rm -f -- {pgid_path}; "
        f"rm -f -- {wrapper_path}; "
        "exit \"$command_status\""
    )


def scoped_process_cleanup_command(scope: str, signal: str) -> str:
    if signal not in ("TERM", "KILL"):
        raise ValueError(f"unsupported cleanup signal: {signal}")
    scope_dir = shlex.quote(f"{COMMAND_SCOPE_ROOT}/{scope}")
    return (
        f"for pgid_file in {scope_dir}/*.pgid; do "
        "[ -r \"$pgid_file\" ] || continue; "
        "pgid=$(cat -- \"$pgid_file\"); "
        "case $pgid in ''|*[!0-9]*) continue;; esac; "
        f"kill -{signal} -- \"-$pgid\" 2>/dev/null || true; "
        "done; "
        + _marked_process_cleanup_command(scope, signal)
        + "; "
        + _wrapper_cleanup_command(f"{scope_dir}/*.wrapper", signal)
        + (f"; rm -rf -- {scope_dir}" if signal == "KILL" else "")
    )


def scoped_command_cleanup_command(
    scope: str, command_ids: list[str], signal: str
) -> str:
    if signal not in ("TERM", "KILL"):
        raise ValueError(f"unsupported cleanup signal: {signal}")
    pgid_paths = [
        shlex.quote(f"{COMMAND_SCOPE_ROOT}/{scope}/{command_id}.pgid")
        for command_id in command_ids
    ]
    if not pgid_paths:
        return ":"
    paths = " ".join(pgid_paths)
    wrapper_paths = " ".join(
        shlex.quote(f"{COMMAND_SCOPE_ROOT}/{scope}/{command_id}.wrapper")
        for command_id in command_ids
    )
    artifact_paths = " ".join(
        shlex.quote(f"{COMMAND_SCOPE_ROOT}/{scope}/{command_id}.{suffix}")
        for command_id in command_ids
        for suffix in ("pgid", "wrapper", "stdout", "stderr")
    )
    command = (
        f"for pgid_file in {paths}; do "
        "[ -r \"$pgid_file\" ] || continue; "
        "pgid=$(cat -- \"$pgid_file\"); "
        "case $pgid in ''|*[!0-9]*) continue;; esac; "
        f"kill -{signal} -- \"-$pgid\" 2>/dev/null || true; "
        "done; "
        + _marked_process_cleanup_command(scope, signal, command_ids)
        + "; "
        + _wrapper_cleanup_command(wrapper_paths, signal)
    )
    return command + (f"; rm -f -- {artifact_paths}" if signal == "KILL" else "")


def _wrapper_cleanup_command(wrapper_paths: str, signal: str) -> str:
    return (
        f"for wrapper_file in {wrapper_paths}; do "
        "[ -r \"$wrapper_file\" ] || continue; "
        "wrapper_pid=$(cat -- \"$wrapper_file\"); "
        "case $wrapper_pid in ''|*[!0-9]*) continue;; esac; "
        f"kill -{signal} \"$wrapper_pid\" 2>/dev/null || true; "
        "done"
    )


def _marked_process_cleanup_command(
    scope: str, signal: str, command_ids: list[str] | None = None
) -> str:
    scope_marker = shlex.quote(f"{COMMAND_SCOPE_ENV}={scope}")
    command_filter = ""
    if command_ids is not None:
        command_checks = " || ".join(
            "tr '\\000' '\\n' 2>/dev/null < \"$env_file\" | grep -Fx -- "
            + shlex.quote(f"{COMMAND_ID_ENV}={command_id}")
            + " > /dev/null"
            for command_id in command_ids
        )
        command_filter = f" && {{ {command_checks}; }}"
    return (
        "for env_file in /proc/[0-9]*/environ; do "
        "[ -r \"$env_file\" ] || continue; "
        f"if tr '\\000' '\\n' 2>/dev/null < \"$env_file\" | grep -Fx -- {scope_marker} > /dev/null"
        f"{command_filter}; then "
        "pid=${env_file#/proc/}; pid=${pid%/environ}; "
        f"kill -{signal} \"$pid\" 2>/dev/null || true; "
        "fi; done"
    )
