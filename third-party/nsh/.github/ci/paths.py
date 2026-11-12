"""Checks that each workflow runs on every change that can affect what it tests.

The Rust workflows run only when the crates they build change, listed one by
one in their `paths` (or, for a workflow that runs on every pull request
because its job is required, in the list of its `dorny/paths-filter` step). A crate they build (directly or through a path
dependency, dev-dependencies included) that is missing from the list would
let a change through untested, so this compares the lists with the
workspace's dependency graph (`cargo metadata --no-deps`, no download).

    python3 .github/ci/paths.py          # check
    python3 .github/ci/paths.py --print  # the `paths` each workflow needs
"""

import fnmatch
import json
import pathlib
import subprocess
import sys

import yaml

ROOT = pathlib.Path(__file__).resolve().parents[2]

# What each workflow builds and tests (its `-p` packages), and the files
# outside those crates it reads (tests' fixtures, `include_bytes!`).
WORKFLOWS = {
    "website.yml": {
        "packages": ["nsh-platform-web", "nsh-bundler", "nsh-cli", "xtask"],
        "files": [
            "website/**", "skills/**", "examples/tasks/**", "examples/tasks-rs/**",
            "examples/gallery/**",
        ],
        # Pull requests build the site only when it or the web runtime changes:
        # Rust application's `web` job builds the web runtime for every change
        # to the crates, and main's deployment builds the site after a merge.
        "pull_request": [
            "website/**", "skills/**", "examples/tasks/**", "examples/tasks-rs/**",
            "crates/nsh-platform-web/**",
        ],
    },
    "tui.yml": {
        "packages": ["nsh-platform-tui", "nsh-base"],
        "files": ["examples/counter/**"],
    },
    "core.yml": {
        "packages": [
            "nsh-core", "nsh-macros", "nsh-js", "nsh-engine",
            "nsh-bundler", "nsh-package", "nsh-updater", "nsh-base", "nsh-testing",
        ],
        # The fonts nsh-core's, nsh-macros', nsh-bundler's and nsh-engine's
        # tests read.
        "files": [
            "examples/counter/**", "examples/gallery/**", "examples/bench/**",
            "tests/compat/cases/layout/fonts/**",
            # nsh-core's test of Android's event codes.
            "crates/nsh-platform-android/java/com/longbridge/nsh/Native.java",
        ],
    },
    "compat.yml": {
        # `nsh build` builds the apps, nsh-compat's checks link the rest.
        "packages": ["nsh-cli", "nsh-core", "nsh-js", "nsh-base", "nsh-engine"],
        # The apps it builds and runs.
        "files": [
            "tests/compat/**", "examples/counter/**", "examples/desktop/**",
            "examples/gallery/**", "examples/hopper/**",
        ],
    },
    "linux.yml": {
        "packages": [
            "nsh-platform-linux", "nsh-linux-host", "nsh-linux-app",
            "nsh-cli", "nsh-dev", "xtask",
        ],
        # `nsh test --target` runs the examples' tests.
        "files": ["crates/gpui/**", "examples/counter/**", "examples/gallery/**"],
    },
    "windows.yml": {
        "packages": [
            "nsh-platform-windows", "nsh-windows-host", "nsh-windows-app",
            "nsh-cli", "nsh-dev", "xtask",
        ],
        # `nsh test --target` runs the examples' tests.
        "files": ["examples/counter/**", "examples/gallery/**"],
    },
    "rust-app.yml": {
        # The macOS check also tests nsh-platform-apple.
        "packages": [
            "gallery-native", "rust-exports-native", "post-editor-native", "tasks-rs",
            "nsh-cli", "nsh-platform-web", "nsh-platform-apple",
        ],
        # `nsh test` runs the examples' tests.
        "files": [
            "examples/counter/**", "examples/gallery/**", "examples/gallery-rs/**",
            "examples/rust-exports/**", "examples/post-editor/**", "examples/tasks-rs/**",
        ],
    },
}

ALWAYS = ["Cargo.toml", "Cargo.lock", ".cargo/**", "rust-toolchain.toml", ".github/actions/cargo/**"]


def crates():
    """Workspace members: name -> (directory, names of the members it depends on)."""
    out = subprocess.run(
        ["cargo", "metadata", "--no-deps", "--format-version", "1"],
        cwd=ROOT, check=True, capture_output=True, text=True,
    ).stdout
    packages = json.loads(out)["packages"]
    members = {p["name"] for p in packages}
    return {
        p["name"]: (
            pathlib.Path(p["manifest_path"]).parent.relative_to(ROOT).as_posix(),
            {d["name"] for d in p["dependencies"] if d["name"] in members and d.get("path")},
        )
        for p in packages
    }


def needed(name, spec, graph):
    seen, stack = set(), list(spec["packages"])
    while stack:
        package = stack.pop()
        if package not in seen:
            seen.add(package)
            stack.extend(graph[package][1])
    dirs = sorted(f"{graph[p][0]}/**" for p in seen)
    dirs = [d for d in dirs if not covered(d, spec["files"])]
    return dirs + spec["files"] + ALWAYS + [f".github/workflows/{name}"]


def covered(path, patterns):
    probe = path.replace("**", "x/y")
    return any(fnmatch.fnmatch(probe, p) for p in patterns)


def filtered(workflow):
    """The patterns of a workflow's `dorny/paths-filter` step, if it has one."""
    for job in workflow["jobs"].values():
        for step in job.get("steps", []):
            if step.get("uses", "").startswith("dorny/paths-filter"):
                filters = yaml.safe_load(step["with"]["filters"])
                return [p for patterns in filters.values() for p in patterns]
    return None


PULL_REQUEST_TYPES = ["opened", "synchronize", "reopened", "ready_for_review", "closed"]


def main():
    graph = crates()
    failed = False
    # Merge queues need a result on their synthetic commit as well as on PRs.
    # Check every PR workflow, including those outside the Rust path graph.
    for path in sorted((ROOT / ".github/workflows").glob("*.yml")):
        events = yaml.safe_load(path.read_text()).get(True, {})
        if "pull_request" in events:
            group = events.get("merge_group")
            if not isinstance(group, dict) or group.get("types") != ["checks_requested"]:
                failed = True
                print(f"{path.name} must handle merge_group: checks_requested")
            # Drafts wait for `ready_for_review`; `closed` cancels what a
            # merged or closed pull request still has queued (AGENTS.md "CI").
            types = (events["pull_request"] or {}).get("types")
            if types != PULL_REQUEST_TYPES:
                failed = True
                print(f"{path.name} must take pull_request types {PULL_REQUEST_TYPES}")
    for name, spec in WORKFLOWS.items():
        want = needed(name, spec, graph)
        if "--print" in sys.argv:
            print(f"{name}:")
            print("\n".join(f'      - "{p}"' for p in want))
            continue
        workflow = yaml.safe_load((ROOT / ".github/workflows" / name).read_text())
        on = workflow[True]
        for event in ("push", "pull_request"):
            if event not in on:
                continue
            patterns = (on[event] or {}).get("paths")
            if patterns is None and event == "pull_request":
                patterns = filtered(workflow)
            patterns = patterns or ["**"]
            wanted = want
            if event == "pull_request" and "pull_request" in spec:
                wanted = spec["pull_request"] + ALWAYS + [f".github/workflows/{name}"]
            missing = [p for p in wanted if not covered(p, patterns)]
            if missing:
                failed = True
                print(f"{name} ({event}) does not run on changes to: {', '.join(missing)}")
    if failed:
        print("Add them to the workflow's paths or paths filter (python3 .github/ci/paths.py --print).")
        sys.exit(1)


main()
