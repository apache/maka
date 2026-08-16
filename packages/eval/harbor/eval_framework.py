"""Authoritative Eval harness framework selection.

`run_trial.py` validates the argv framework and installs it here before Harbor,
Pier, or the shared relay can import. The relay must not read the environment.
"""

from __future__ import annotations

_FRAMEWORKS = frozenset({"harbor", "pier"})
_framework: str | None = None


def install(framework: str) -> None:
    if framework not in _FRAMEWORKS:
        raise RuntimeError("framework must be harbor or pier")
    global _framework
    _framework = framework


def selected() -> str:
    if _framework not in _FRAMEWORKS:
        raise RuntimeError("Eval framework selection is not installed")
    return _framework
