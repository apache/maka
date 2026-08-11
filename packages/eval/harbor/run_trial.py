"""Run exactly one pinned Harbor or Pier Trial."""

import asyncio
import contextlib
import fcntl
import hashlib
import importlib
import importlib.metadata
import os
import signal
import sys
from pathlib import Path
from typing import Iterator


@contextlib.contextmanager
def task_cache_lock(cache_dir: Path, identity: str) -> Iterator[None]:
    lock_dir = cache_dir / ".maka-locks"
    lock_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    lock_path = lock_dir / f"{hashlib.sha256(identity.encode()).hexdigest()}.lock"
    flags = os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(lock_path, flags, 0o600)
    try:
        os.fchmod(descriptor, 0o600)
        fcntl.flock(descriptor, fcntl.LOCK_EX)
        yield
    finally:
        fcntl.flock(descriptor, fcntl.LOCK_UN)
        os.close(descriptor)


async def main() -> None:
    framework, expected_version, config_path = sys.argv[1:]
    distribution = {"harbor": "harbor", "pier": "datacurve-pier"}.get(framework)
    if distribution is None:
        raise RuntimeError("framework must be harbor or pier")
    if importlib.metadata.version(distribution) != expected_version:
        raise RuntimeError(f"{framework} version does not match the experiment spec")
    task = asyncio.current_task()
    assert task is not None
    loop = asyncio.get_running_loop()
    for host_signal in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(host_signal, task.cancel)
    config_file = Path(config_path)
    try:
        config_type = importlib.import_module(f"{framework}.models.trial.config").TrialConfig
        trial_type = importlib.import_module(f"{framework}.trial.trial").Trial
        config = config_type.model_validate_json(config_file.read_text())
        config_file.unlink()
        if framework == "harbor":
            from harbor.constants import TASK_CACHE_DIR
            from harbor.tasks.client import TaskClient

            task_identity = config.task.model_dump_json()
            with task_cache_lock(TASK_CACHE_DIR, task_identity):
                task_id = config.task.get_task_id()
                await TaskClient().download_tasks(
                    task_ids=[task_id],
                    overwrite=config.task.overwrite,
                    output_dir=config.task.download_dir,
                )
        trial = await trial_type.create(config)
        await trial.run()
    finally:
        config_file.unlink(missing_ok=True)
        for host_signal in (signal.SIGINT, signal.SIGTERM):
            loop.remove_signal_handler(host_signal)


if __name__ == "__main__":
    asyncio.run(main())
