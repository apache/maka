# Licensed to the Apache Software Foundation (ASF) under one
# or more contributor license agreements.  See the NOTICE file
# distributed with this work for additional information
# regarding copyright ownership.  The ASF licenses this file
# to you under the Apache License, Version 2.0 (the
# "License"); you may not use this file except in compliance
# with the License.  You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing,
# software distributed under the License is distributed on an
# "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
# KIND, either express or implied.  See the License for the
# specific language governing permissions and limitations
# under the License.

"""Run exactly one pinned Harbor or Pier Trial."""

import asyncio
import contextlib
import fcntl
import hashlib
import importlib
import importlib.metadata
import json
import os
import signal
import sys
from pathlib import Path
from typing import AsyncIterator

FRAMEWORK_VERSION_MISMATCH_EXIT_CODE = 78


class FrameworkVersionMismatch(Exception):
    pass


TASK_CACHE_PROTOCOL_VERSION = 1


@contextlib.asynccontextmanager
async def task_cache_lock(cache_dir: Path, identity: str) -> AsyncIterator[None]:
    lock_dir = cache_dir / ".maka-locks"
    lock_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    lock_path = lock_dir / f"{hashlib.sha256(identity.encode()).hexdigest()}.lock"
    flags = os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(lock_path, flags, 0o600)
    acquired = False
    try:
        os.fchmod(descriptor, 0o600)
        while not acquired:
            try:
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
                acquired = True
            except BlockingIOError:
                await asyncio.sleep(0.05)
        yield
    finally:
        if acquired:
            fcntl.flock(descriptor, fcntl.LOCK_UN)
        os.close(descriptor)


def ready_task(cache_dir: Path, identity: str) -> tuple[Path, Path | None]:
    namespace = cache_dir / ".maka-tasks" / hashlib.sha256(identity.encode()).hexdigest()
    marker = namespace / "ready.json"
    try:
        value = json.loads(marker.read_text())
        if set(value) != {"version", "target"}:
            return namespace, None
        if value["version"] != TASK_CACHE_PROTOCOL_VERSION or not isinstance(
            value["target"], str
        ):
            return namespace, None
        target = (namespace / value["target"]).resolve()
        if (
            not target.is_relative_to(namespace.resolve())
            or not target.is_dir()
            or not any(target.iterdir())
        ):
            return namespace, None
        return namespace, target
    except (OSError, TypeError, ValueError):
        return namespace, None


def publish_ready_task(namespace: Path, target: Path) -> None:
    resolved_namespace = namespace.resolve()
    resolved_target = target.resolve()
    if not resolved_target.is_relative_to(resolved_namespace):
        raise RuntimeError("Harbor task cache target escaped its Maka namespace")
    relative_target = resolved_target.relative_to(resolved_namespace).as_posix()
    marker = namespace / "ready.json"
    temporary = namespace / ".ready.tmp"
    descriptor = os.open(
        temporary,
        os.O_CREAT | os.O_WRONLY | os.O_TRUNC | getattr(os, "O_NOFOLLOW", 0),
        0o600,
    )
    try:
        with os.fdopen(descriptor, "w") as stream:
            descriptor = -1
            json.dump(
                {"version": TASK_CACHE_PROTOCOL_VERSION, "target": relative_target},
                stream,
            )
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, marker)
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        temporary.unlink(missing_ok=True)


async def run_trial(framework: str, expected_version: str, config_file: Path) -> None:
    from eval_framework import install

    install(framework)
    distribution = {"harbor": "harbor", "pier": "datacurve-pier"}[framework]
    if importlib.metadata.version(distribution) != expected_version:
        raise FrameworkVersionMismatch
    try:
        config_type = importlib.import_module(f"{framework}.models.trial.config").TrialConfig
        trial_type = importlib.import_module(f"{framework}.trial.trial").Trial
        config = config_type.model_validate_json(config_file.read_text())
        config_file.unlink()
        if framework == "harbor":
            from harbor.constants import TASK_CACHE_DIR

            task_identity = config.task.get_task_id().model_dump_json()
            async with task_cache_lock(TASK_CACHE_DIR, task_identity):
                namespace, ready = ready_task(TASK_CACHE_DIR, task_identity)
                namespace.mkdir(parents=True, exist_ok=True, mode=0o700)
                config.task.download_dir = namespace
                config.task.overwrite = ready is None
                trial = await create_harbor_trial(trial_type, config)
                target = Path(trial.task.task_dir)
                if ready is not None and target.resolve() != ready:
                    raise RuntimeError("Harbor task cache target changed for one identity")
                if ready is None:
                    publish_ready_task(namespace, target)
        else:
            trial = await trial_type.create(config)
        await trial.run()
    finally:
        config_file.unlink(missing_ok=True)


def apply_subject_egress_policy(task: object) -> None:
    required = os.environ.get("MAKA_EVAL_EGRESS_REQUIRED") == "1"
    allowed_host = os.environ.get("MAKA_EVAL_EGRESS_ALLOWED_HOST")
    if not required:
        return
    if not allowed_host:
        raise RuntimeError("required Eval egress proxy host is unavailable")
    agent = task.config.agent
    agent.network_mode = "allowlist"
    agent.allowed_hosts = [allowed_host]


async def create_harbor_trial(trial_type: type, config: object) -> object:
    trial_type._resolve_agent_skills(config)
    task, task_download_result = await trial_type._load_task(config)
    apply_subject_egress_policy(task)
    if task.has_steps:
        from harbor.trial.multi_step import MultiStepTrial

        return MultiStepTrial(
            config,
            _task=task,
            _task_download_result=task_download_result,
        )
    from harbor.trial.single_step import SingleStepTrial

    return SingleStepTrial(
        config,
        _task=task,
        _task_download_result=task_download_result,
    )


async def main() -> None:
    from eval_framework import install

    framework, expected_version, config_path = sys.argv[1:]
    install(framework)
    task = asyncio.current_task()
    assert task is not None
    loop = asyncio.get_running_loop()
    teardown_requested = False

    def request_teardown() -> None:
        nonlocal teardown_requested
        if teardown_requested:
            return
        teardown_requested = True
        try:
            from relay_agent import request_host_teardown
            request_host_teardown()
        finally:
            task.cancel()

    for host_signal in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(host_signal, request_teardown)
    try:
        try:
            await run_trial(framework, expected_version, Path(config_path))
        except FrameworkVersionMismatch:
            raise SystemExit(FRAMEWORK_VERSION_MISMATCH_EXIT_CODE) from None
        except asyncio.CancelledError:
            if not teardown_requested:
                raise
    finally:
        for host_signal in (signal.SIGINT, signal.SIGTERM):
            loop.remove_signal_handler(host_signal)


if __name__ == "__main__":
    asyncio.run(main())
