"""Behavior contract for the shared command-scope teardown.

``cleanup_process_scope`` only ever runs from an adapter's ``finally`` while the
agent's own exception is in flight (claude_code_agent.py, codex_agent.py,
kimi_code_agent.py all guard it with ``if abnormal_exit``). An exception raised
there replaces the exception being propagated, so a teardown that raises rewrites
the trial's cause: an ``AgentTimeoutError`` reached Harbor as a
``NonZeroAgentExitCodeError``, which the runner reads as an infrastructure
failure instead of a graded timeout.

Run directly: ``python3 packages/headless/harbor/tests/test_process_scope.py``
"""

from __future__ import annotations

import ast
import asyncio
import os
import shutil
import signal
import subprocess
import sys
import time
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from process_scope import (  # noqa: E402
    CLEANUP_TIMEOUT_SEC,
    COMMAND_ID_ENV,
    COMMAND_SCOPE_ENV,
    COMMAND_SCOPE_ROOT,
    cleanup_process_scope,
    exec_cleanup_command,
    scoped_command,
    scoped_command_cleanup_command,
    scoped_process_cleanup_command,
)


class _Logger:
    def __init__(self) -> None:
        self.warnings: list[str] = []

    def warning(self, message: str, *args: object) -> None:
        self.warnings.append(message % args)


class _Agent:
    def __init__(self, fail: bool) -> None:
        self.logger = _Logger()
        self.commands: list[str] = []
        self.timeouts: list[int | None] = []
        self._fail = fail

    async def exec_as_agent(
        self, environment: object, command: str, timeout_sec: int | None = None
    ) -> None:
        self.commands.append(command)
        self.timeouts.append(timeout_sec)
        if self._fail:
            raise RuntimeError("Command failed (exit -9)")


def test_a_failing_teardown_never_replaces_the_agent_failure() -> None:
    agent = _Agent(fail=True)

    async def run() -> None:
        try:
            raise TimeoutError("agent deadline")
        finally:
            await cleanup_process_scope(agent, object(), "scope-1")

    try:
        asyncio.run(run())
    except TimeoutError:
        pass
    else:
        raise AssertionError("the agent's own failure did not survive teardown")
    assert len(agent.commands) == 2, agent.commands
    assert len(agent.logger.warnings) == 2, agent.logger.warnings


def test_kill_still_runs_after_term_fails() -> None:
    agent = _Agent(fail=True)
    asyncio.run(cleanup_process_scope(agent, object(), "scope-2"))
    signals = ["KILL" if "kill -KILL" in c else "TERM" for c in agent.commands]
    assert signals == ["TERM", "KILL"], signals


def test_every_teardown_exec_is_time_bounded() -> None:
    """Teardown swallows every failure because it is best effort, and an exec
    issued with no bound is the one failure swallowing cannot cover: Harbor waits
    on `communicate()` forever, so the trial hangs and no reward is produced. A
    graded cell was observed stalled for 1524s with both teardown execs alive."""
    # Asserting against the constant alone is circular: setting it to None
    # passes every such assertion and hands Harbor back the unbounded
    # `communicate()` this whole branch exists to remove. The budget has to be
    # a real one, so say what a real one is before comparing anything to it.
    assert isinstance(CLEANUP_TIMEOUT_SEC, int), CLEANUP_TIMEOUT_SEC
    assert not isinstance(CLEANUP_TIMEOUT_SEC, bool), CLEANUP_TIMEOUT_SEC
    assert 0 < CLEANUP_TIMEOUT_SEC < 3600, CLEANUP_TIMEOUT_SEC

    agent = _Agent(fail=False)
    asyncio.run(cleanup_process_scope(agent, object(), "scope-5"))
    assert agent.timeouts == [CLEANUP_TIMEOUT_SEC, CLEANUP_TIMEOUT_SEC], agent.timeouts


def test_the_shared_helper_carries_the_budget() -> None:
    agent = _Agent(fail=False)
    asyncio.run(exec_cleanup_command(agent, object(), "cleanup"))
    assert agent.timeouts == [CLEANUP_TIMEOUT_SEC], agent.timeouts


def test_no_teardown_reaches_exec_as_agent_without_the_helper() -> None:
    """Pinning the helper is not the same as pinning its use. The bridged
    executor in maka_agent.py is the call site that actually shipped unbounded
    and stalled a graded cell for 1524s, and restoring that one line — a direct
    `exec_as_agent` with no budget — leaves every other test in this file green.

    This suite is stdlib-only by CI contract and maka_agent needs Harbor, so it
    cannot be imported here. `ast` reads the source without running it, which is
    enough to pin the thing that matters: the cleanup shells reach the transport
    through the helper that owns the budget, or they do not run at all.
    """
    source = Path(__file__).resolve().parent.parent / "maka_agent.py"
    tree = ast.parse(source.read_text(encoding="utf-8"))
    offenders = []
    for node in ast.walk(tree):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        if "cleanup" not in node.name:
            continue
        for call in ast.walk(node):
            if not isinstance(call, ast.Call):
                continue
            name = getattr(call.func, "attr", None) or getattr(call.func, "id", None)
            if name == "exec_as_agent":
                offenders.append(f"{node.name}:{call.lineno}")
    assert not offenders, (
        f"{source.name} teardown calls exec_as_agent directly at {offenders}; "
        "route it through exec_cleanup_command so the budget cannot be dropped"
    )


def test_the_marker_is_on_the_process_that_owns_both_replays() -> None:
    """The pgid file cannot describe the replay until after it is forked, so the
    marker covers that window — but only if it names something that outlives a
    single kill. Marking each `cat` instead leaves their parent anonymous: it
    survives the sweep that kills the first `cat` and starts the second, which
    the sweep has already walked past, and on the last pass that one keeps the
    caller's stdout open for good. So the owner is what has to carry the marker.
    """
    command = scoped_command("echo hi", "scope-6", "cid")
    replay = command.split("wait \"$command_pid\"", 1)[1]
    marker = f"env {COMMAND_SCOPE_ENV}=scope-6 {COMMAND_ID_ENV}=cid"
    assert replay.count(marker) == 1, replay
    owner = replay.split(marker, 1)[1].lstrip()
    assert owner.startswith("sh -c"), owner
    assert "cat --" not in owner.split("&", 1)[0].split("sh -c", 1)[0], owner


def test_cleanup_kills_the_wrapper_before_it_hunts_for_the_replay() -> None:
    """Reaping the command is what makes the wrapper fork a replay, so a sweep
    ordered command-first races the wrapper it just woke: the replay can appear
    after the `/proc` sweep has passed and the wrapper die before recording a
    pgid, leaving a replay no handle describes, still holding the caller's
    stdout. That is the 1524s hang again, and the KILL pass is where it bites —
    a command that ignores SIGTERM survives to die on exactly that pass.

    Killing the wrapper first ends it: a dead wrapper forks nothing, so every
    replay that can exist exists before the sweeps run.
    """
    for command in (
        scoped_process_cleanup_command("scope-7", "KILL"),
        scoped_command_cleanup_command("scope-7", ["cid"], "KILL"),
    ):
        wrapper = command.index("wrapper_file")
        pgid = command.index("pgid_file")
        marker = command.index("/proc/[0-9]*/environ")
        assert wrapper < pgid < marker, command


def test_a_broken_logger_never_replaces_the_agent_failure() -> None:
    class _RaisingLogger(_Logger):
        def warning(self, message: str, *args: object) -> None:
            raise RuntimeError("logging handler is down")

    missing = _Agent(fail=True)
    del missing.logger
    raising = _Agent(fail=True)
    raising.logger = _RaisingLogger()

    for agent in (missing, raising):

        async def run(agent: _Agent = agent) -> None:
            try:
                raise TimeoutError("agent deadline")
            finally:
                await cleanup_process_scope(agent, object(), "scope-4")

        try:
            asyncio.run(run())
        except TimeoutError:
            continue
        raise AssertionError("reporting the teardown failure became one")


def test_cancellation_still_propagates() -> None:
    class _Cancelling(_Agent):
        async def exec_as_agent(
            self, environment: object, command: str, timeout_sec: int | None = None
        ) -> None:
            self.commands.append(command)
            raise asyncio.CancelledError

    agent = _Cancelling(fail=False)
    try:
        asyncio.run(cleanup_process_scope(agent, object(), "scope-3"))
    except asyncio.CancelledError:
        pass
    else:
        raise AssertionError("teardown swallowed cancellation")
    assert len(agent.commands) == 1, agent.commands


def _process_table() -> str:
    """The process listing, or `""` where this host will not produce one.

    A sandbox can refuse `ps` even though it is on PATH, so presence is not
    availability: checking only `which` turns a host that cannot run this test
    into a host that fails it.
    """
    try:
        return subprocess.run(  # noqa: S603 - fixed argv, no shell interpolation
            ["ps", "-A", "-o", "pid=,command="],
            check=False,
            timeout=30,
            capture_output=True,
            text=True,
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return ""


def _holders(stdout_path: Path) -> list[str]:
    """The replay processes still holding the pipe open. Draining the pipe would
    unblock the replay and hide the defect, so ask the process table instead.

    Matching the path alone would also match the wrapper, whose `bash -c` script
    text contains that path: the pre-cleanup guard below would then pass with no
    replay alive at all, which is a false PASS in the one direction that matters.
    So require the command itself to be the replay.
    """
    listing = _process_table().splitlines()
    marker = f"cat -- {stdout_path}"
    return [
        line.strip()
        for line in listing
        if line.strip().split(maxsplit=1)[1:2] == [marker]
    ]


def test_cleanup_reaps_the_output_replay_so_the_reader_reaches_eof() -> None:
    """The wrapper captures the command's output to a file and replays it after
    the command exits, so that a descendant outliving the command cannot hold the
    exec's stdout open. The replay itself is the hole: when the caller stops
    reading — which is exactly what an agent-phase timeout does — it blocks in
    ``pipe_write`` forever, and it is not the wrapper PID, so whether anything
    reaps it comes down to which process group the shell happened to leave it in.

    This runs on a host with no ``/proc``, where the marker sweep cannot run, so
    what it pins is the portable handle alone: the recorded process group has to
    be enough by itself. A stranded replay means the exec never sees EOF, so the
    cell hangs and the verifier never runs.
    """
    if shutil.which("bash") is None or not _process_table():
        return

    scope = f"test-scope-{uuid.uuid4().hex}"
    command_id = "replay"
    stdout_path = Path(COMMAND_SCOPE_ROOT) / scope / f"{command_id}.stdout"
    # Comfortably past a 64 KiB pipe buffer, so the replay blocks partway
    # through rather than finishing before anyone can observe it.
    payload = "yes 0123456789abcdef | head -c 400000"

    wrapper = subprocess.Popen(  # noqa: S603 - fixed argv, no shell interpolation
        ["bash", "-c", scoped_command(payload, scope, command_id)],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
    )
    try:
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            if stdout_path.exists() and stdout_path.stat().st_size >= 400000:
                break
            time.sleep(0.1)
        else:
            raise AssertionError("the command never finished writing its output")
        # The wrapper starts the replay once the command exits; give it that
        # step before asserting on what teardown can still reach.
        time.sleep(1)
        assert _holders(stdout_path), (
            "the replay never blocked, so this test would pass no matter what "
            "teardown reaps"
        )

        for signal in ("TERM", "KILL"):
            subprocess.run(  # noqa: S603 - fixed argv, no shell interpolation
                ["bash", "-c", scoped_process_cleanup_command(scope, signal)],
                check=False,
                timeout=30,
                capture_output=True,
            )

        survivors = _holders(stdout_path)
        assert not survivors, (
            f"teardown left {len(survivors)} process(es) holding the exec's "
            "pipe; that is the hang that strands a cell with no verifier"
        )
    finally:
        wrapper.kill()
        wrapper.wait(timeout=10)
        shutil.rmtree(Path(COMMAND_SCOPE_ROOT) / scope, ignore_errors=True)


def test_command_cleanup_reaps_the_wrapper_and_its_command() -> None:
    """The per-command cleanup cancels one in-flight exec, and until now nothing
    ran it. Its handles are built from the command id, so a wrong suffix aims
    every kill at a file that does not exist and the whole thing degrades to a
    no-op that still exits 0 — the text assertions above stay green through it.

    Only `bash`, `sleep` and signal 0 are needed, so this runs where there is no
    `/proc` and the marker sweep cannot: what it pins is that the recorded
    handles alone reach both the wrapper and the command it is waiting on.
    """
    if shutil.which("bash") is None:
        return

    scope = f"test-scope-{uuid.uuid4().hex}"
    command_id = "cancelme"
    scope_dir = Path(COMMAND_SCOPE_ROOT) / scope
    wrapper_file = scope_dir / f"{command_id}.wrapper"
    pgid_file = scope_dir / f"{command_id}.pgid"

    payload = "sleep 300"
    wrapper = subprocess.Popen(  # noqa: S603 - fixed argv, no shell interpolation
        ["bash", "-c", scoped_command(payload, scope, command_id)],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
    )
    try:
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            if wrapper_file.exists() and pgid_file.exists():
                break
            time.sleep(0.1)
        else:
            raise AssertionError("the wrapper never recorded its handles")
        command_pgid = int(pgid_file.read_text().strip())
        # Nothing is proved by killing what was already dead.
        os.killpg(command_pgid, 0)
        assert wrapper.poll() is None, "the wrapper exited before cleanup ran"

        subprocess.run(  # noqa: S603 - fixed argv, no shell interpolation
            ["bash", "-c", scoped_command_cleanup_command(scope, [command_id], "KILL")],
            check=False,
            timeout=30,
            capture_output=True,
        )

        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            if wrapper.poll() is not None:
                break
            time.sleep(0.1)
        # That the wrapper is gone proves nothing on its own: this same pass
        # deletes the files the replay reads, so a wrapper cleanup never touched
        # still finds its replay failing and exits on its own, with the status
        # of the command it was waiting on. Only the signal tells the two apart,
        # and only one of them means the cleanup's handles were aimed correctly.
        assert wrapper.poll() == -signal.SIGKILL, (
            f"the wrapper ended with {wrapper.poll()}, not SIGKILL; cleanup "
            "never reached it and it merely ran out of things to wait for"
        )
        try:
            os.killpg(command_pgid, 0)
        except ProcessLookupError:
            pass
        else:
            raise AssertionError(
                "cleanup left the command's process group alive; a cancelled "
                "exec that keeps running is what strands the cell"
            )
    finally:
        wrapper.kill()
        wrapper.wait(timeout=10)
        shutil.rmtree(scope_dir, ignore_errors=True)


def _main() -> int:
    tests = [value for name, value in sorted(globals().items()) if name.startswith("test_")]
    failures = 0
    for test in tests:
        try:
            test()
        except Exception as error:  # noqa: BLE001 - standalone runner reports all
            failures += 1
            print(f"FAIL {test.__name__}: {error!r}")
        else:
            print(f"PASS {test.__name__}")
    print(f"\n{len(tests) - failures} passed, {failures} failed")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(_main())
