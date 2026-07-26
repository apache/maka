"""Shared task-native model-budget attestation for Pier benchmark adapters."""

from __future__ import annotations

import re
from collections.abc import Callable
from typing import Any

POLICY_ID = "task-native-full-budget-v1"
_POSITIVE_INT_RE = re.compile(r"[1-9][0-9]*")


def deadline_policy_from_env(
    get_env: Callable[[str], str | None],
) -> dict[str, Any] | None:
    policy_id = get_env("MAKA_BENCHMARK_DEADLINE_POLICY")
    if not policy_id:
        return None
    if policy_id != POLICY_ID:
        raise RuntimeError(f"MAKA_BENCHMARK_DEADLINE_POLICY must be {POLICY_ID}")
    model_budget_sec = _positive_int(get_env("MAKA_CELL_TIMEOUT_SEC"), "MAKA_CELL_TIMEOUT_SEC")
    settlement_grace_sec = _positive_int(
        get_env("MAKA_CELL_SETTLEMENT_GRACE_SEC"),
        "MAKA_CELL_SETTLEMENT_GRACE_SEC",
    )
    hard_timeout_sec = _positive_int(
        get_env("MAKA_CELL_HARD_TIMEOUT_SEC"),
        "MAKA_CELL_HARD_TIMEOUT_SEC",
    )
    if hard_timeout_sec != model_budget_sec + settlement_grace_sec:
        raise RuntimeError("MAKA_CELL_HARD_TIMEOUT_SEC must equal T + G")
    return {
        "id": policy_id,
        "modelBudgetSec": model_budget_sec,
        "settlementGraceSec": settlement_grace_sec,
        "hardTimeoutSec": hard_timeout_sec,
    }


def _positive_int(raw: str | None, name: str) -> int:
    value = raw.strip() if raw is not None else ""
    if _POSITIVE_INT_RE.fullmatch(value) is None:
        raise RuntimeError(f"{name} must be a positive integer")
    return int(value)
