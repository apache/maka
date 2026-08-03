"""Behavior contract for the harbor/pier harness-tree selection.

Pier 0.3.0 (Datacurve's Harbor fork) builds a trial by calling
``agent.install_spec()`` and ``agent.network_allowlist()``
(``pier/trial/execution.py`` -> ``_create_environment``) and validates
``TrialResult.agent_info`` against ``pier.models.trial.result.AgentInfo``
(``pier/trial/trial.py`` -> ``run``). Plain Harbor 0.13.2 has none of that and
its parallel classes are type-incompatible with Pier's. ``harness_compat``
selects the tree at import time; these tests lock:

- under Pier: the adapters subclass Pier's BaseInstalledAgent, their
  ``to_agent_info()`` returns Pier's AgentInfo (the exact DeepSWE pilot
  failure), and install_spec/network_allowlist return the shapes and raise the
  configuration errors Pier consumes;
- under plain Harbor (real, or simulated via meta-path poisoning of ``pier``):
  the harbor tree is selected and the modules import and instantiate cleanly;
- a pier package that exists but fails its own import re-raises instead of
  silently falling back to the compat harbor tree.

Run under an interpreter that has Harbor or Pier installed, e.g. either uv tool
venv (pytest is optional; a ``__main__`` runner executes every ``test_*``
function). Setting ``MAKA_HARNESS_COMPAT_EXPECT=pier`` turns missing pier
coverage into a failure instead of a skip:

    ~/.local/share/uv/tools/datacurve-pier/bin/python \
        packages/headless/harbor/tests/test_harness_compat.py
    ~/.local/share/uv/tools/harbor/bin/python \
        packages/headless/harbor/tests/test_harness_compat.py
"""

from __future__ import annotations

import asyncio
import contextlib
import functools
import importlib
import io
import os
import sys
import tempfile
from pathlib import Path

_HARBOR_DIR = Path(__file__).resolve().parent.parent
if str(_HARBOR_DIR) not in sys.path:
    sys.path.insert(0, str(_HARBOR_DIR))

_ADAPTER_MODULES = (
    "harness_compat",
    "maka_agent",
    "kimi_code_agent",
    "codex_agent",
    "claude_code_agent",
    "opencode_agent",
)

# Sentinel returned by tests that cannot run under this interpreter; the
# __main__ runner counts these as skips, not passes. pytest treats the return
# value as a no-op, so the file stays runnable either way.
SKIPPED = object()

try:
    from pier.agents.installed.base import BaseInstalledAgent as PierBaseInstalledAgent
    from pier.models.agent.network import NetworkAllowlist
    from pier.models.trial.result import AgentInfo as PierAgentInfo

    _PIER_IMPORTABLE = True
except ImportError:  # pragma: no cover - depends on the running interpreter
    NetworkAllowlist = None  # type: ignore[assignment]
    _PIER_IMPORTABLE = False


def _pier_gate() -> bool:
    """True when pier-tree coverage can run under this interpreter.

    With MAKA_HARNESS_COMPAT_EXPECT=pier, expected-but-unavailable pier
    coverage is a failure, not a skip, so a misconfigured pier-side CI job
    cannot go green while silently testing nothing.
    """
    if _PIER_IMPORTABLE:
        return True
    if os.environ.get("MAKA_HARNESS_COMPAT_EXPECT") == "pier":
        raise AssertionError(
            "MAKA_HARNESS_COMPAT_EXPECT=pier but pier is not importable"
        )
    return False


def _isolated_maka_env(test):
    """Run a test with all MAKA_* keys scrubbed from os.environ.

    The adapters' _get_env falls back to os.environ, so an operator shell that
    exported e.g. MAKA_PROVIDER_PROXY_URL or MAKA_HOST_NO_AUTH would flip these
    contracts. MAKA_HARNESS_COMPAT_EXPECT is the runner's own control variable,
    not adapter env, and stays visible.
    """

    @functools.wraps(test)
    def wrapper():
        saved = {
            key: value
            for key, value in os.environ.items()
            if key.startswith("MAKA_") and key != "MAKA_HARNESS_COMPAT_EXPECT"
        }
        for key in saved:
            del os.environ[key]
        try:
            return test()
        finally:
            os.environ.update(saved)

    return wrapper


def _fresh_adapters():
    for name in _ADAPTER_MODULES:
        sys.modules.pop(name, None)
    return (
        importlib.import_module("maka_agent"),
        importlib.import_module("kimi_code_agent"),
        importlib.import_module("codex_agent"),
        importlib.import_module("claude_code_agent"),
        importlib.import_module("opencode_agent"),
    )


def _raises(callable_, exception_type, *fragments) -> None:
    try:
        callable_()
    except exception_type as error:
        text = str(error)
        for fragment in fragments:
            assert fragment in text, (fragment, text)
        return
    raise AssertionError(f"expected {exception_type.__name__}")


class _RaisingPierFinder:
    """Meta-path finder that makes ``import pier`` raise a chosen error."""

    def __init__(self, error_factory) -> None:
        self._error_factory = error_factory

    def find_spec(self, name, path=None, target=None):  # noqa: ANN001, ARG002
        if name == "pier" or name.startswith("pier."):
            raise self._error_factory(name)
        return None


def _without_pier_modules():
    saved = {
        key: mod
        for key, mod in sys.modules.items()
        if key == "pier" or key.startswith("pier.")
    }
    for key in list(saved):
        del sys.modules[key]
    for key in _ADAPTER_MODULES:
        sys.modules.pop(key, None)
    return saved


def _restore_modules(saved_pier) -> None:
    for key in _ADAPTER_MODULES:
        sys.modules.pop(key, None)
    sys.modules.update(saved_pier)


@_isolated_maka_env
def test_pier_tree_selected_and_agent_info_is_pier_type():
    if not _pier_gate():
        return SKIPPED
    maka_mod, kimi_mod, codex_mod, claude_mod, opencode_mod = _fresh_adapters()
    for cls in (
        maka_mod.MakaAgent,
        kimi_mod.MakaKimiCodeAgent,
        codex_mod.MakaCodexAgent,
        claude_mod.MakaClaudeCodeAgent,
        opencode_mod.MakaOpenCodeAgent,
    ):
        assert issubclass(cls, PierBaseInstalledAgent), cls.__mro__
        agent = cls(logs_dir=Path("/tmp"), model_name="k3")
        # The DeepSWE pilot failed pydantic validation because agent_info was a
        # harbor-tree AgentInfo; Pier's TrialResult only accepts its own type.
        info = agent.to_agent_info()
        assert isinstance(info, PierAgentInfo), type(info)
        # Every adapter pins its own toolchain (mounted or host-side); Pier's
        # inherited install specs (e.g. Codex's npm/nvm network install) must
        # never run, or an offline task would fail its build and the pinned
        # build under comparison would drift.
        assert agent.install_spec() is None


@_isolated_maka_env
def test_maka_agent_network_policy_under_pier():
    if not _pier_gate():
        return SKIPPED
    maka_mod, _, _, _, _ = _fresh_adapters()

    # Host-side LLM mode: model calls happen on the host, container is offline.
    host_side = maka_mod.MakaAgent(
        logs_dir=Path("/tmp"), extra_env={"MAKA_HOST_NO_AUTH": "true"}
    )
    allow = host_side.network_allowlist()
    assert isinstance(allow, NetworkAllowlist)
    assert allow.domains == []

    # The inert fake backend makes no model calls at all. Configure it via the
    # CLI_FLAGS kwarg: in both harbor 0.13.2 and pier 0.3.0 env_fallback reads
    # os.environ only, so extra_env cannot set a flag with a truthy default.
    fake = maka_mod.MakaAgent(logs_dir=Path("/tmp"), backend="fake")
    assert fake.network_allowlist().domains == []

    # Pier task-run mode runs Maka in the task container. It may reach only the
    # host credential proxy, never the upstream provider directly. Pier loads
    # its secret --env-file into os.environ; only --ae values reach extra_env.
    os.environ["MAKA_PROVIDER_PROXY_URL"] = "https://host.docker.internal"
    os.environ["MAKA_PROVIDER_PROXY_TOKEN"] = "ephemeral-token"
    task_run = maka_mod.MakaAgent(
        logs_dir=Path("/tmp"),
        extra_env={"MAKA_HARBOR_MODE": "task-run"},
    )
    assert task_run.network_allowlist().domains == ["host.docker.internal"]
    del os.environ["MAKA_PROVIDER_PROXY_URL"]
    del os.environ["MAKA_PROVIDER_PROXY_TOKEN"]

    fake_task_run = maka_mod.MakaAgent(
        logs_dir=Path("/tmp"),
        backend="fake",
        extra_env={"MAKA_HARBOR_MODE": "task-run"},
    )
    assert fake_task_run.network_allowlist().domains == []

    missing_task_run_proxy = maka_mod.MakaAgent(
        logs_dir=Path("/tmp"), extra_env={"MAKA_HARBOR_MODE": "task-run"}
    )
    _raises(
        missing_task_run_proxy.network_allowlist,
        ValueError,
        "host provider proxy",
    )

    # A cell-mode ai-sdk run without host-side provider config would need
    # in-container egress the empty allowlist forbids; fail at environment
    # creation instead.
    mismatched = maka_mod.MakaAgent(logs_dir=Path("/tmp"))
    _raises(
        mismatched.network_allowlist,
        RuntimeError,
        "host-side provider configuration",
        "backend=fake",
        "task-run",
    )


@_isolated_maka_env
def test_kimi_agent_network_shape_under_pier():
    if not _pier_gate():
        return SKIPPED
    _, kimi_mod, _, _, _ = _fresh_adapters()

    # Portless HTTPS endpoint (default 443): allowlisted without any warning.
    configured = kimi_mod.MakaKimiCodeAgent(
        logs_dir=Path("/tmp"),
        extra_env={"MAKA_PROVIDER_PROXY_URL": "https://api.kimi.com/coding/v1"},
    )
    stderr = io.StringIO()
    with contextlib.redirect_stderr(stderr):
        allow = configured.network_allowlist()
    assert isinstance(allow, NetworkAllowlist)
    assert allow.domains == ["api.kimi.com"]
    assert stderr.getvalue() == ""

    # NetworkAllowlist carries domains only, but Pier's Squid egress proxy for
    # allow_internet=false tasks additionally restricts destination ports to
    # 80/443 (Safe_ports acl in pier/environments/agent_setup.py). A proxy on
    # any other port is silently unreachable in offline tasks, so the adapter
    # must warn on stderr while still allowlisting the host (internet tasks
    # ignore the allowlist and the port is legal there).
    proxied = kimi_mod.MakaKimiCodeAgent(
        logs_dir=Path("/tmp"),
        extra_env={"MAKA_PROVIDER_PROXY_URL": "https://proxy.internal:8443/v1"},
    )
    stderr = io.StringIO()
    with contextlib.redirect_stderr(stderr):
        proxied_allow = proxied.network_allowlist()
    assert proxied_allow.domains == ["proxy.internal"]
    assert "ports 80 and 443" in stderr.getvalue(), stderr.getvalue()

    # No fallback domain: a missing proxy URL fails at allowlist time with the
    # same error _runtime_env raises, instead of granting spurious egress.
    unset = kimi_mod.MakaKimiCodeAgent(logs_dir=Path("/tmp"))
    _raises(
        unset.network_allowlist,
        ValueError,
        "Kimi Code requires the host provider proxy",
    )

    # Pier's NetworkAllowlist rejects ':' domains, so IPv6 literals cannot be
    # allowlisted; the adapter refuses them explicitly.
    ipv6 = kimi_mod.MakaKimiCodeAgent(
        logs_dir=Path("/tmp"),
        extra_env={"MAKA_PROVIDER_PROXY_URL": "https://[2001:db8::1]:8443/v1"},
    )
    _raises(ipv6.network_allowlist, ValueError, "IPv6")


@_isolated_maka_env
def test_codex_agent_network_shape_under_pier():
    if not _pier_gate():
        return SKIPPED
    _, _, codex_mod, _, _ = _fresh_adapters()

    # The container runs the pinned Codex CLI against the maka-http provider
    # config pointed at the host proxy; that proxy host is the single egress
    # grant. Pier's inherited allowlist would fall back to api.openai.com,
    # which this adapter never dials.
    configured = codex_mod.MakaCodexAgent(
        logs_dir=Path("/tmp"),
        extra_env={"MAKA_PROVIDER_PROXY_URL": "http://host.docker.internal:443"},
    )
    stderr = io.StringIO()
    with contextlib.redirect_stderr(stderr):
        allow = configured.network_allowlist()
    assert isinstance(allow, NetworkAllowlist)
    assert allow.domains == ["host.docker.internal"]
    assert stderr.getvalue() == ""

    # Squid-unreachable port: warn on stderr, still allowlist the host (same
    # shared contract as the Kimi adapter).
    proxied = codex_mod.MakaCodexAgent(
        logs_dir=Path("/tmp"),
        extra_env={"MAKA_PROVIDER_PROXY_URL": "https://proxy.internal:8443/v1"},
    )
    stderr = io.StringIO()
    with contextlib.redirect_stderr(stderr):
        proxied_allow = proxied.network_allowlist()
    assert proxied_allow.domains == ["proxy.internal"]
    assert "ports 80 and 443" in stderr.getvalue(), stderr.getvalue()

    # No fallback domain: a missing proxy URL fails at allowlist time instead
    # of granting api.openai.com egress the trial would never use.
    unset = codex_mod.MakaCodexAgent(logs_dir=Path("/tmp"))
    _raises(
        unset.network_allowlist,
        ValueError,
        "Codex requires the host provider proxy",
    )


@_isolated_maka_env
def test_opencode_agent_network_shape_under_pier():
    if not _pier_gate():
        return SKIPPED
    _, _, _, _, opencode_mod = _fresh_adapters()

    # The pinned toolchain is bind-mounted read-only and only verified in
    # install(); Pier's inherited spec would reinstall OpenCode from the
    # network, which offline tasks cannot reach and which would break the
    # fixed-build comparison.
    agent = opencode_mod.MakaOpenCodeAgent(
        logs_dir=Path("/tmp"),
        extra_env={"MAKA_PROVIDER_PROXY_URL": "http://host.docker.internal:443"},
    )
    assert agent.install_spec() is None

    # The container dials only the host provider proxy (see
    # _run_with_stop_sentinel); that proxy host is the single egress grant.
    stderr = io.StringIO()
    with contextlib.redirect_stderr(stderr):
        allow = agent.network_allowlist()
    assert isinstance(allow, NetworkAllowlist)
    assert allow.domains == ["host.docker.internal"]
    assert stderr.getvalue() == ""

    # Squid-unreachable port: warn on stderr, still allowlist the host (same
    # shared contract as the Kimi and Codex adapters).
    proxied = opencode_mod.MakaOpenCodeAgent(
        logs_dir=Path("/tmp"),
        extra_env={"MAKA_PROVIDER_PROXY_URL": "https://proxy.internal:8443/v1"},
    )
    stderr = io.StringIO()
    with contextlib.redirect_stderr(stderr):
        proxied_allow = proxied.network_allowlist()
    assert proxied_allow.domains == ["proxy.internal"]
    assert "ports 80 and 443" in stderr.getvalue(), stderr.getvalue()

    # No fallback domain: a missing proxy URL fails at allowlist time, same as
    # the run path, instead of granting spurious egress.
    unset = opencode_mod.MakaOpenCodeAgent(logs_dir=Path("/tmp"))
    _raises(
        unset.network_allowlist,
        ValueError,
        "OpenCode requires the host provider proxy",
    )

@_isolated_maka_env
def test_opencode_agent_hydrates_container_log_to_host_logs_dir():
    # Runs under both interpreters: pier replaces the default /logs bind-mount
    # when the runner passes explicit --mounts-json (pier docker.py), so the
    # host-side adapter must download the CLI stream before _error_messages()
    # and populate_context_post_run() parse it; under plain Harbor the file is
    # already host-side and the download is skipped.
    _, _, _, _, opencode_mod = _fresh_adapters()

    with tempfile.TemporaryDirectory() as tmp:
        agent = opencode_mod.MakaOpenCodeAgent(logs_dir=Path(tmp))

        written = {}

        class _PierEnv:
            async def download_file(self, remote, local):
                written[remote] = Path(local)
                Path(local).write_text('{"type":"step_finish"}\n')

        asyncio.run(agent._download_agent_logs(_PierEnv()))
        assert written == {"/logs/agent/opencode.txt": Path(tmp) / "opencode.txt"}

        # Idempotent: an existing host-side log (plain-Harbor bind mount, or a
        # repeated call from run()'s finally) is never overwritten.
        calls = []

        class _HarborEnv:
            async def download_file(self, remote, local):
                calls.append(remote)

        asyncio.run(agent._download_agent_logs(_HarborEnv()))
        assert calls == []
        assert (Path(tmp) / "opencode.txt").read_text() == '{"type":"step_finish"}\n'


@_isolated_maka_env
def test_kimi_runtime_env_forwards_ipv6_proxy_url():
    # Runs under BOTH trees (no pier gate): _runtime_env keeps main's plain-
    # Harbor contract and forwards the proxy URL opaquely, IPv6 included; the
    # IPv6 rejection is a Pier NetworkAllowlist constraint and lives only in
    # the network_allowlist() path.
    _, kimi_mod, _, _, _ = _fresh_adapters()
    agent = kimi_mod.MakaKimiCodeAgent(
        logs_dir=Path("/tmp"),
        extra_env={
            "MAKA_PROVIDER_PROXY_URL": "http://[::1]:43210/v1",
            "MAKA_PROVIDER_PROXY_TOKEN": "test-token",
            "MAKA_MODEL": "k3",
        },
    )
    assert agent._runtime_env()["KIMI_MODEL_BASE_URL"] == "http://[::1]:43210/v1"


@_isolated_maka_env
def test_codex_agent_hydrates_agent_logs_best_effort():
    # Runs under BOTH trees. Pier replaces the default /logs/agent bind mount
    # when a trial passes --mounts-json while capabilities.mounted stays true
    # (pier docker.py), so pier's own log download never runs; the adapter must
    # hydrate codex.txt and the sessions rollouts itself or _events() reads
    # nothing and a real token-burning run is misclassified as failed. Under
    # Harbor the log dir is bind-mounted, so hydration must skip host-side
    # files, and a download failure must stay best-effort.
    import asyncio
    import tempfile

    _, _, codex_mod, _, _ = _fresh_adapters()

    class _RecordingEnvironment:
        def __init__(self) -> None:
            self.files: list[tuple[str, Path]] = []
            self.dirs: list[tuple[str, Path]] = []

        async def download_file(self, source_path, target_path):
            self.files.append((source_path, Path(target_path)))
            Path(target_path).write_text("", encoding="utf-8")

        async def download_dir(self, source_dir, target_dir):
            self.dirs.append((source_dir, Path(target_dir)))

    with tempfile.TemporaryDirectory() as tmp:
        logs_dir = Path(tmp)
        agent = codex_mod.MakaCodexAgent(logs_dir=logs_dir)
        environment = _RecordingEnvironment()
        asyncio.run(agent._download_agent_logs(environment))
        assert environment.files == [("/logs/agent/codex.txt", logs_dir / "codex.txt")]
        assert environment.dirs == [("/logs/agent/sessions", logs_dir / "sessions")]
        # docker cp of `dir/.` requires the target directory to exist.
        assert (logs_dir / "sessions").is_dir()

        # Both targets are now host-side (the Harbor bind-mount case): no
        # further downloads.
        asyncio.run(agent._download_agent_logs(environment))
        assert len(environment.files) == 1
        assert len(environment.dirs) == 1

    class _FailingEnvironment:
        async def download_file(self, source_path, target_path):
            raise RuntimeError("container already torn down")

        async def download_dir(self, source_dir, target_dir):
            raise RuntimeError("container already torn down")

    with tempfile.TemporaryDirectory() as tmp:
        agent = codex_mod.MakaCodexAgent(logs_dir=Path(tmp))
        asyncio.run(agent._download_agent_logs(_FailingEnvironment()))


@_isolated_maka_env
def test_claude_code_agent_hydrates_agent_logs_best_effort():
    _, _, _, claude_mod, _ = _fresh_adapters()

    class _RecordingEnvironment:
        def __init__(self) -> None:
            self.files: list[tuple[str, Path]] = []
            self.dirs: list[tuple[str, Path]] = []

        async def download_file(self, source_path, target_path):
            self.files.append((source_path, Path(target_path)))
            Path(target_path).write_text("", encoding="utf-8")

        async def download_dir(self, source_dir, target_dir):
            self.dirs.append((source_dir, Path(target_dir)))

    with tempfile.TemporaryDirectory() as tmp:
        logs_dir = Path(tmp)
        agent = claude_mod.MakaClaudeCodeAgent(logs_dir=logs_dir)
        environment = _RecordingEnvironment()
        asyncio.run(agent._download_agent_logs(environment))
        assert environment.files == [
            ("/logs/agent/claude-code.txt", logs_dir / "claude-code.txt")
        ]
        assert environment.dirs == [
            ("/logs/agent/sessions", logs_dir / "sessions")
        ]


@_isolated_maka_env
def test_harbor_tree_used_without_pier():
    saved_pier = _without_pier_modules()
    finder = _RaisingPierFinder(
        lambda name: ModuleNotFoundError(f"pier blocked for test: {name}", name=name)
    )
    sys.meta_path.insert(0, finder)
    try:
        from harbor.agents.installed.base import (
            BaseInstalledAgent as HarborBaseInstalledAgent,
        )

        compat = importlib.import_module("harness_compat")
        assert compat.IS_PIER is False
        assert compat.NetworkAllowlist is None
        maka = importlib.import_module("maka_agent")
        kimi = importlib.import_module("kimi_code_agent")
        codex = importlib.import_module("codex_agent")
        claude = importlib.import_module("claude_code_agent")
        for cls in (
            maka.MakaAgent,
            kimi.MakaKimiCodeAgent,
            codex.MakaCodexAgent,
            claude.MakaClaudeCodeAgent,
        ):
            # The plain-Harbor path must keep subclassing the harbor tree so
            # Terminal-Bench's Harbor 0.13.2 runner keeps validating its own
            # AgentInfo type.
            assert issubclass(cls, HarborBaseInstalledAgent), cls.__mro__
            agent = cls(logs_dir=Path("/tmp"))
            # Pier-only hooks stay resolvable but inert under plain Harbor:
            # they return None before any mode or proxy-URL validation runs.
            assert agent.install_spec() is None
            assert agent.network_allowlist() is None
    finally:
        sys.meta_path.remove(finder)
        _restore_modules(saved_pier)


@_isolated_maka_env
def test_broken_pier_install_reraises():
    # A pier package that exists but fails its own import (here: a missing
    # dependency) must re-raise instead of silently selecting the compat
    # harbor tree, which would reproduce the TrialResult.agent_info failure.
    saved_pier = _without_pier_modules()
    finder = _RaisingPierFinder(
        lambda name: ModuleNotFoundError("No module named 'socksio'", name="socksio")
    )
    sys.meta_path.insert(0, finder)
    try:
        try:
            importlib.import_module("harness_compat")
        except ModuleNotFoundError as error:
            assert error.name == "socksio", error
        else:
            raise AssertionError("harness_compat swallowed a broken pier import")
    finally:
        sys.meta_path.remove(finder)
        _restore_modules(saved_pier)


def _main() -> int:
    tests = [value for name, value in sorted(globals().items()) if name.startswith("test_")]
    passes = failures = skips = 0
    for test in tests:
        try:
            result = test()
        except Exception as error:  # noqa: BLE001 - standalone runner reports all
            failures += 1
            print(f"FAIL {test.__name__}: {error!r}")
        else:
            if result is SKIPPED:
                skips += 1
                print(f"SKIP {test.__name__} (pier not importable)")
            else:
                passes += 1
                print(f"PASS {test.__name__}")
    print(f"\n{passes} passed, {skips} skipped, {failures} failed")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(_main())
