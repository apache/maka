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

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from process_scope import cleanup_process_scope  # noqa: E402


class _Logger:
    def __init__(self) -> None:
        self.warnings: list[str] = []

    def warning(self, message: str, *args: object) -> None:
        self.warnings.append(message % args)


class _Agent:
    def __init__(self, fail: bool) -> None:
        self.logger = _Logger()
        self.commands: list[str] = []
        self._fail = fail

    async def exec_as_agent(self, environment: object, command: str) -> None:
        self.commands.append(command)
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
        async def exec_as_agent(self, environment: object, command: str) -> None:
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
