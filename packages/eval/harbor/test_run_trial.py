import multiprocessing
import queue
import tempfile
import unittest
from pathlib import Path

from run_trial import task_cache_lock


def acquire_lock(cache_dir: str, identity: str, acquired: multiprocessing.Queue) -> None:
    with task_cache_lock(Path(cache_dir), identity):
        acquired.put(identity)


class TaskCacheLockTest(unittest.TestCase):
    def test_same_task_waits_for_the_existing_process(self) -> None:
        context = multiprocessing.get_context("spawn")
        acquired = context.Queue()
        with tempfile.TemporaryDirectory() as cache_dir:
            with task_cache_lock(Path(cache_dir), "same-task"):
                process = context.Process(
                    target=acquire_lock,
                    args=(cache_dir, "same-task", acquired),
                )
                process.start()
                with self.assertRaises(queue.Empty):
                    acquired.get(timeout=0.2)
            self.assertEqual(acquired.get(timeout=2), "same-task")
            process.join(timeout=2)
            self.assertEqual(process.exitcode, 0)

    def test_different_task_does_not_wait(self) -> None:
        context = multiprocessing.get_context("spawn")
        acquired = context.Queue()
        with tempfile.TemporaryDirectory() as cache_dir:
            with task_cache_lock(Path(cache_dir), "first-task"):
                process = context.Process(
                    target=acquire_lock,
                    args=(cache_dir, "second-task", acquired),
                )
                process.start()
                self.assertEqual(acquired.get(timeout=2), "second-task")
                process.join(timeout=2)
                self.assertEqual(process.exitcode, 0)


if __name__ == "__main__":
    unittest.main()
