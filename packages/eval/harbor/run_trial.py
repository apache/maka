"""Run exactly one pinned Harbor or Pier Trial."""

import asyncio
import importlib
import importlib.metadata
import signal
import sys
from pathlib import Path


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
        trial = await trial_type.create(config)
        await trial.run()
    finally:
        config_file.unlink(missing_ok=True)
        for host_signal in (signal.SIGINT, signal.SIGTERM):
            loop.remove_signal_handler(host_signal)


asyncio.run(main())
