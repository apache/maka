"""Harbor verifier policy for recoverable Maka benchmark trials.

The verifier runs inside the same live post-agent environment. Retrying here
preserves filesystem state and services started by the agent; retrying the
whole Harbor trial would violate Pass@1.
"""

from __future__ import annotations

import json
import math
import re
import shlex
import time
from pathlib import Path
from typing import Any

from harbor.models.trial.paths import EnvironmentPaths
from harbor.models.verifier.result import VerifierResult
from harbor.verifier.verifier import Verifier


_OUTCOME_FILENAME = "maka-verifier-outcome.json"
_INFRA_LINE_PREFIXES = (
    "e: unable to fetch some archives",
    "e: failed to fetch http://",
    "e: failed to fetch https://",
    "curl: (35) openssl ssl_connect: ssl_error_syscall in connection to astral.sh:443",
)
_APT_REPOSITORY_502_RE = re.compile(
    r"\berr:\d+\s+https?://[^\s'\"\\]+(?:(?!\\n)[^\r\n])*(?:\\n|\r?\n)[ \t]*502[ \t]+bad gateway\b",
    re.IGNORECASE,
)


class MakaVerifierInfrastructureError(RuntimeError):
    """The verifier did not produce a candidate-attributable result."""


class _TimedVerifierEnvironment:
    """Narrow environment decorator that hard-limits the test command.

    Harbor 0.13.2 applies one timeout around the whole verifier. This inner
    command timeout leaves recovery time for verifier infrastructure failures
    and, unlike cancelling the host coroutine, kills the process inside the
    task container.
    """

    def __init__(self, environment: Any, timeout_sec: float) -> None:
        self._environment = environment
        self._timeout_sec = timeout_sec
        self.timed_out = False

    def __getattr__(self, name: str) -> Any:
        return getattr(self._environment, name)

    async def exec(self, command: str, **kwargs: Any) -> Any:
        if "/tests/" not in command or command.lstrip().startswith("chmod +x"):
            return await self._environment.exec(command, **kwargs)
        wrapped = (
            "timeout --signal=KILL --kill-after=5s "
            f"{self._timeout_sec:g}s bash -lc {shlex.quote(command)}"
        )
        result = await self._environment.exec(
            wrapped,
            **{
                **kwargs,
                "timeout_sec": math.ceil(self._timeout_sec + 10),
            },
        )
        self.timed_out = getattr(result, "return_code", None) in (124, 137)
        return result


class MakaVerifier(Verifier):
    def __init__(
        self,
        *args: Any,
        attempt_timeout_sec: float | None = None,
        max_attempts: int = 2,
        **kwargs: Any,
    ) -> None:
        super().__init__(*args, **kwargs)
        native_timeout = attempt_timeout_sec or self.task.config.verifier.timeout_sec
        if not math.isfinite(native_timeout) or native_timeout <= 0:
            raise ValueError("attempt_timeout_sec must be a positive finite number")
        if max_attempts != 2:
            raise ValueError("Maka verifier policy requires exactly two attempts")
        self._attempt_timeout_sec = float(native_timeout)
        self._max_attempts = max_attempts
        self._base_environment = self.environment
        self._timed_environment = _TimedVerifierEnvironment(
            self._base_environment,
            self._attempt_timeout_sec,
        )
        self.environment = self._timed_environment

    async def verify(self) -> VerifierResult:
        attempts: list[dict[str, Any]] = []
        last_error: Exception | None = None
        for attempt in range(1, self._max_attempts + 1):
            await self._clear_attempt_outputs()
            self._timed_environment.timed_out = False
            started = time.monotonic()
            result: VerifierResult | None = None
            try:
                result = await super().verify()
            except Exception as error:
                last_error = error

            classification = self._classify_attempt(result)
            record: dict[str, Any] = {
                "attempt": attempt,
                "classification": classification,
                "durationMs": round((time.monotonic() - started) * 1000),
            }
            reward = _reward(result)
            if reward is not None:
                record["reward"] = reward
            attempts.append(record)

            if classification in ("passed", "failed"):
                self._write_outcome(classification, attempts)
                assert result is not None
                return result
            if classification == "timeout":
                # The verifier command has started and may have mutated its
                # workspace. Replaying it in-place would not evaluate the same
                # post-agent state, so a timeout is terminal candidate evidence.
                self.trial_paths.reward_text_path.write_text("0\n", encoding="utf-8")
                self._write_outcome("candidate_timeout", attempts)
                return VerifierResult(rewards={"reward": 0})
            if attempt < self._max_attempts:
                last_error = None
                continue

            self._write_outcome("infra_failed", attempts)
            raise MakaVerifierInfrastructureError(
                "verifier infrastructure failed after two attempts"
            ) from last_error

        raise AssertionError("unreachable verifier attempt state")

    def _classify_attempt(
        self,
        result: VerifierResult | None,
    ) -> str:
        if self._timed_environment.timed_out:
            return "timeout"
        reward = _reward(result)
        if reward is not None and reward > 0:
            return "passed"
        stdout = _read_optional_text(self.trial_paths.test_stdout_path)
        if _is_infra_failure(stdout):
            return "infra_setup_failed"
        if reward is not None:
            return "failed"
        return "infra_failed"

    async def _clear_attempt_outputs(self) -> None:
        for path in (
            self.trial_paths.reward_text_path,
            self.trial_paths.reward_json_path,
            self.trial_paths.test_stdout_path,
        ):
            path.unlink(missing_ok=True)
        env_paths = EnvironmentPaths.for_os(self.environment.os)
        targets = " ".join(
            shlex.quote(str(path))
            for path in (
                env_paths.reward_text_path,
                env_paths.reward_json_path,
                env_paths.verifier_dir / "test-stdout.txt",
            )
        )
        await self._base_environment.exec(f"rm -f {targets}", user="root")

    def _write_outcome(self, outcome: str, attempts: list[dict[str, Any]]) -> None:
        path = self.trial_paths.verifier_dir / _OUTCOME_FILENAME
        temporary = path.with_suffix(".tmp")
        temporary.write_text(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "outcome": outcome,
                    "attempts": attempts,
                },
                separators=(",", ":"),
            )
            + "\n",
            encoding="utf-8",
        )
        temporary.replace(path)


def _reward(result: VerifierResult | None) -> float | None:
    if result is None or not result.rewards:
        return None
    reward = result.rewards.get("reward")
    if isinstance(reward, (int, float)) and math.isfinite(float(reward)):
        return float(reward)
    return None


def _read_optional_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""


def _is_infra_failure(text: str) -> bool:
    return _APT_REPOSITORY_502_RE.search(text) is not None or any(
        line.strip().lower().startswith(prefix)
        for line in text.splitlines()
        for prefix in _INFRA_LINE_PREFIXES
    )
