"""Process-scope helpers shared by Harbor agent adapters."""

from __future__ import annotations

import asyncio
import shlex
from typing import Any


COMMAND_SCOPE_ENV = "MAKA_HARBOR_COMMAND_SCOPE"
COMMAND_ID_ENV = "MAKA_HARBOR_COMMAND_ID"
COMMAND_SCOPE_ROOT = "/tmp/maka-harbor-command-scopes"
# Ends in `.pgid` so the scope-wide `*.pgid` sweep reaps the replay without
# needing to know it exists.
REPLAY_PGID_SUFFIX = "replay.pgid"
# Teardown signals process groups and walks `/proc` once per signal; seconds is
# the honest scale. A pass that has not finished inside this has already failed
# at its job, and waiting longer only holds the trial open. This bounds one
# pass, not the whole teardown: two passes plus the settle between them put the
# worst case at 120.2s.
CLEANUP_TIMEOUT_SEC = 60


async def exec_cleanup_command(agent: Any, environment: Any, command: str) -> None:
    """Run one teardown pass under the shared bound.

    Two separate teardowns run these cleanup shells — the adapters' and the
    bridged executor's — and each reaches its exec from a `finally` with the
    agent's own exception in flight. One of them shipped without a bound and
    stalled a graded cell for 1524s. Owning the budget here is what stops the
    next call site from being the one that forgets: the callers still keep
    their own error handling, which is the part that legitimately differs.
    """
    await agent.exec_as_agent(
        environment, command=command, timeout_sec=CLEANUP_TIMEOUT_SEC
    )


async def cleanup_process_scope(
    agent: Any, environment: Any, scope: str
) -> None:
    """Reap the scope's leftovers. Callers run this from a `finally` while the
    agent's own exception is in flight, so raising here would replace the real
    failure with the teardown's — which is how agent timeouts were being
    recorded as infrastructure failures. Cancellation still propagates.

    Every failure here is swallowed because teardown is best effort. Time is the
    one failure that swallowing cannot cover: an exec issued with no bound waits
    on `communicate()` forever, so a teardown that hangs takes the whole trial
    with it and no reward is ever produced. The bound is what makes best effort
    true."""
    for signal in ("TERM", "KILL"):
        try:
            await exec_cleanup_command(
                agent, environment, scoped_process_cleanup_command(scope, signal)
            )
        except Exception as error:  # noqa: BLE001 - teardown is best effort.
            logger = getattr(agent, "logger", None)
            if logger is not None:
                # Reporting the failure must not become one: an exception from
                # here escapes the same `finally` and rewrites the same agent
                # failure this function exists to preserve.
                try:
                    logger.warning(
                        "process scope %s %s cleanup failed: %s", scope, signal, error
                    )
                except Exception:  # noqa: BLE001 - logging is best effort too.
                    pass
        if signal == "TERM":
            await asyncio.sleep(0.2)


def scoped_command(command: str, scope: str, command_id: str) -> str:
    scope_dir = shlex.quote(f"{COMMAND_SCOPE_ROOT}/{scope}")
    pgid_path = shlex.quote(f"{COMMAND_SCOPE_ROOT}/{scope}/{command_id}.pgid")
    replay_pgid_path = shlex.quote(
        f"{COMMAND_SCOPE_ROOT}/{scope}/{command_id}.{REPLAY_PGID_SUFFIX}"
    )
    wrapper_path = shlex.quote(f"{COMMAND_SCOPE_ROOT}/{scope}/{command_id}.wrapper")
    stdout_path = shlex.quote(f"{COMMAND_SCOPE_ROOT}/{scope}/{command_id}.stdout")
    stderr_path = shlex.quote(f"{COMMAND_SCOPE_ROOT}/{scope}/{command_id}.stderr")
    marker_env = (
        f"{COMMAND_SCOPE_ENV}={shlex.quote(scope)} "
        f"{COMMAND_ID_ENV}={shlex.quote(command_id)}"
    )
    return (
        f"mkdir -p -- {scope_dir}; printf '%s\\n' \"$$\" > {wrapper_path}; set -m; "
        f"env {marker_env} "
        f"bash -lc {shlex.quote(command)} > {stdout_path} 2> {stderr_path} & "
        "command_pid=$!; "
        "set +m; "
        f"printf '%s\\n' \"$command_pid\" > {pgid_path}; "
        "wait \"$command_pid\" 2>/dev/null; command_status=$?; "
        # The replay writes to the caller's stdout, so it blocks forever once the
        # caller stops reading — which is exactly what an agent-phase timeout
        # does. It needs a teardown handle of its own, and it gets two, because
        # each covers where the other is blind. The scope marker is a name
        # teardown knows before the replay is forked, so it needs no window to
        # be recorded in; but it is only readable once `env` has exec'd, and a
        # `/proc`-less host cannot read it at all. The recorded process group
        # covers both of those, and costs a window of its own between this fork
        # and the write below. Neither handle closes that window alone — the
        # cleanup order does, by killing the wrapper before it looks for what
        # the wrapper can still produce.
        #
        # The marker goes on the shell that owns both replays, not on each
        # `cat`. Marking only the `cat`s leaves the owner anonymous: a sweep
        # kills the first `cat`, the owner survives it and starts the second,
        # and the second is a process the sweep has already walked past. On the
        # last pass there is nothing behind it, so that second `cat` holds the
        # caller's stdout open for good. Killing the owner ends the sequence.
        "set -m; "
        f"env {marker_env} sh -c 'cat -- \"$1\"; cat -- \"$2\" >&2' "
        f"replay {stdout_path} {stderr_path} & replay_pid=$!; "
        "set +m; "
        f"printf '%s\\n' \"$replay_pid\" > {replay_pgid_path}; "
        "wait \"$replay_pid\" 2>/dev/null; "
        f"rm -f -- {replay_pgid_path} {stdout_path} {stderr_path}; "
        f"kill -0 -- \"-$command_pid\" 2>/dev/null || rm -f -- {pgid_path}; "
        f"rm -f -- {wrapper_path}; "
        "exit \"$command_status\""
    )


def scoped_process_cleanup_command(scope: str, signal: str) -> str:
    if signal not in ("TERM", "KILL"):
        raise ValueError(f"unsupported cleanup signal: {signal}")
    scope_dir = shlex.quote(f"{COMMAND_SCOPE_ROOT}/{scope}")
    return (
        _wrapper_cleanup_command(f"{scope_dir}/*.wrapper", signal)
        + "; "
        + _pgid_cleanup_command(f"{scope_dir}/*.pgid", signal)
        + "; "
        + _marked_process_cleanup_command(scope, signal)
        + (f"; rm -rf -- {scope_dir}" if signal == "KILL" else "")
    )


def scoped_command_cleanup_command(
    scope: str, command_ids: list[str], signal: str
) -> str:
    if signal not in ("TERM", "KILL"):
        raise ValueError(f"unsupported cleanup signal: {signal}")
    pgid_paths = [
        shlex.quote(f"{COMMAND_SCOPE_ROOT}/{scope}/{command_id}.{suffix}")
        for command_id in command_ids
        for suffix in ("pgid", REPLAY_PGID_SUFFIX)
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
        for suffix in ("pgid", REPLAY_PGID_SUFFIX, "wrapper", "stdout", "stderr")
    )
    command = (
        _wrapper_cleanup_command(wrapper_paths, signal)
        + "; "
        + _pgid_cleanup_command(paths, signal)
        + "; "
        + _marked_process_cleanup_command(scope, signal, command_ids)
    )
    return command + (f"; rm -f -- {artifact_paths}" if signal == "KILL" else "")


def _pgid_cleanup_command(pgid_paths: str, signal: str) -> str:
    return (
        f"for pgid_file in {pgid_paths}; do "
        "[ -r \"$pgid_file\" ] || continue; "
        "pgid=$(cat -- \"$pgid_file\"); "
        "case $pgid in ''|*[!0-9]*) continue;; esac; "
        f"kill -{signal} -- \"-$pgid\" 2>/dev/null || true; "
        "done"
    )


def _wrapper_cleanup_command(wrapper_paths: str, signal: str) -> str:
    """Kill the wrapper first, before anything looks for what it produced.

    The wrapper forks the output replay the moment its command exits, then
    records the replay's process group. Reaping the command before the wrapper
    is what makes that exit happen — so a sweep ordered command-first races the
    wrapper it just woke: the replay can be forked after the `/proc` sweep has
    passed and the wrapper killed before it records a pgid, leaving a replay
    that no handle describes and that still blocks the caller's stdout. Killing
    the wrapper first ends that: a dead wrapper forks nothing, so every replay
    that can exist already exists before the sweeps below run.
    """
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
