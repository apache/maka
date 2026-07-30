"""Select the benchmark harness package tree (plain Harbor vs Pier) at import time.

Terminal-Bench runs the adapters under plain Harbor 0.13.2, where only the
``harbor.*`` tree exists. DeepSWE runs them under Pier 0.3.0 (Datacurve's Harbor
fork), which ships a parallel ``pier.*`` tree plus a backward-compat ``harbor.*``
tree. The trees are type-incompatible: Pier's ``TrialResult.agent_info`` only
validates against ``pier.models.trial.result.AgentInfo``, so an adapter built on
the compat ``harbor.*`` tree fails Pier trial setup with a pydantic
ValidationError before any container or model work.

Selection rule: prefer Pier whenever ``import pier`` succeeds. The plain-Harbor
uv tool venv ships no pier distribution and always selects the harbor tree;
Pier's venv imports pier and selects the pier tree, where the compat
``harbor.*`` tree is never the right choice. The probe falls back to harbor
only when the ``pier`` package itself is absent (ModuleNotFoundError naming
``pier``); any other failure inside pier's own import — a broken install, a
missing dependency — re-raises at the probe, and a pier tree broken below the
top level fails when the first symbol resolves. Falling back in those cases
would silently rebuild the adapters on the compat harbor tree, which Pier's
``TrialResult`` rejects.

Symbols resolve lazily (PEP 562) so each adapter's transitive import surface
stays exactly the names it asks for; the harness-stub smoke tests in
``packages/headless/src/__tests__/harbor-adapter.test.ts`` rely on that to keep
stubbing only the modules each adapter actually uses.
"""

from __future__ import annotations

import importlib
from typing import Any

try:
    import pier  # noqa: F401

    IS_PIER = True
except ModuleNotFoundError as error:
    if error.name != "pier":
        # pier exists but one of its own imports failed. Falling back would
        # silently select the compat harbor tree, so surface the real problem.
        raise
    IS_PIER = False  # plain Harbor venv: no pier distribution

_TREE = "pier" if IS_PIER else "harbor"

# Symbol -> submodule path, identical in both package trees.
_SYMBOL_MODULES = {
    "BaseInstalledAgent": "agents.installed.base",
    "Codex": "agents.installed.codex",
    "CliFlag": "agents.installed.base",
    "with_prompt_template": "agents.installed.base",
    "BaseEnvironment": "environments.base",
    "AgentContext": "models.agent.context",
    "Agent": "models.trajectories",
    "FinalMetrics": "models.trajectories",
    "Step": "models.trajectories",
    "Trajectory": "models.trajectories",
    "EnvironmentPaths": "models.trial.paths",
    "format_trajectory_json": "utils.trajectory_utils",
}


def __getattr__(name: str) -> Any:
    if name == "NetworkAllowlist":
        # Plain Harbor has no per-agent network-policy hook; adapters return
        # None where Pier would receive a NetworkAllowlist.
        if not IS_PIER:
            globals()[name] = None
            return None
        from pier.models.agent.network import NetworkAllowlist

        globals()[name] = NetworkAllowlist
        return NetworkAllowlist
    submodule = _SYMBOL_MODULES.get(name)
    if submodule is None:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    value = getattr(importlib.import_module(f"{_TREE}.{submodule}"), name)
    globals()[name] = value
    return value
