#!/usr/bin/env python3
"""Tests of bench.py: python3 examples/gallery/tools/bench_test.py"""

import json
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import bench  # noqa: E402

PY = sys.executable


class Bench(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())

    def test_cpu_percent_is_per_core(self):
        self.assertEqual(bench.cpu_percent(200, 2.0, 100), 100.0)
        self.assertEqual(bench.cpu_percent(400, 2.0, 100), 200.0)
        self.assertEqual(bench.cpu_percent(5, 0, 100), 0.0)

    def test_stop_reaps_the_whole_tree_even_if_sigterm_is_ignored(self):
        script = ("import signal,subprocess,sys,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);"
                  f"subprocess.Popen([{PY!r},'-c','import signal,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);time.sleep(60)']);"
                  "time.sleep(60)")
        proc = bench.launch([PY, "-c", script], self.dir / "log")
        time.sleep(0.5)
        tree = bench.children(proc.pid)
        self.assertGreaterEqual(len(tree), 2)
        self.assertEqual(bench.stop(proc, grace=0.5), [])
        self.assertEqual(bench.alive(tree), [])

    def test_busy_child_counts_toward_tree_cpu(self):
        proc = bench.launch([PY, "-c", f"import subprocess;subprocess.Popen([{PY!r},'-c','while 1: pass']).wait()"],
                            self.dir / "log")
        try:
            time.sleep(0.3)
            c0, t0 = bench.cpu_ticks(bench.children(proc.pid)), time.monotonic()
            time.sleep(1.0)
            pct = bench.cpu_percent(bench.cpu_ticks(bench.children(proc.pid)) - c0, time.monotonic() - t0)
            self.assertGreater(pct, 60)
            self.assertGreater(bench.memory(bench.children(proc.pid))["rss_mib"], 1)
        finally:
            bench.stop(proc)

    def test_failures_and_timeouts_are_kept_and_summarized_apart(self):
        out = self.dir / "s"
        # No window ever maps for a sleeping process: every run times out and is still recorded.
        code = bench.main(["startup", "--runs", "2", "--timeout", "0.3", "--gap", "0", "--settle", "0",
                           "--out", str(out), "--", PY, "-c", "import time;time.sleep(30)"])
        self.assertEqual(code, 1)
        report = json.loads(out.with_suffix(".json").read_text())
        self.assertEqual(report["schema"], "nsh-bench/1")
        self.assertEqual([s["status"] for s in report["samples"]], ["timeout", "timeout"])
        self.assertTrue(all(s["leaked"] == 0 and s["first_frame_ms"] is None for s in report["samples"]))
        self.assertEqual(report["summary"]["failed"], {"timeout": 2})
        self.assertIsNone(report["summary"]["window_ms"])
        self.assertEqual(len(out.with_suffix(".csv").read_text().splitlines()), 3)

    def test_run_without_window_measures_and_cleans_up(self):
        out = self.dir / "r"
        code = bench.main(["run", "--no-window", "--rounds", "2", "--seconds", "0.6", "--warmup", "0",
                           "--interval", "0.2", "--gap", "0", "--out", str(out), "--", PY, "-c", "while 1: pass"])
        self.assertEqual(code, 0)
        report = json.loads(out.with_suffix(".json").read_text())
        self.assertEqual(report["summary"]["ok"], 2)
        self.assertGreater(report["summary"]["cpu_pct"]["median"], 50)
        self.assertLess(report["summary"]["sampler_cpu_pct"]["median"], 20)

    def test_summary_stats(self):
        s = bench.stats([1, 2, 3, 4, 100])
        self.assertEqual((s["median"], s["p95"], s["min"], s["max"]), (3, 100, 1, 100))
        self.assertIsNone(bench.stats([]))

    def test_size_records_missing_paths(self):
        (self.dir / "d").mkdir()
        (self.dir / "d" / "a").write_bytes(b"x" * 10)
        report = bench.cmd_size(None, [f"dir={self.dir / 'd'}", f"gone={self.dir / 'nope'}"])
        self.assertEqual([(s["bytes"], s["status"]) for s in report["samples"]], [(10, "ok"), (None, "missing")])


if __name__ == "__main__":
    unittest.main()
