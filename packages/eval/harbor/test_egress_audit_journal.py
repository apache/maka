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

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

MODULE_PATH = Path(__file__).with_name("egress_filter.py")
SPEC = importlib.util.spec_from_file_location("maka_eval_egress_journal", MODULE_PATH)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class EgressAuditJournalTest(unittest.TestCase):
    def journal(self, path: Path, limit: int | None = None):
        return MODULE.AuditJournal(path, limit or MODULE.MAX_AUDIT_BYTES)

    def test_serializes_one_ascii_json_record_per_line(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "hits.jsonl"
            normalized_path = "/tasks/\u2028hidden"
            journal = self.journal(path)

            journal.record("tbench_domain", "tbench.ai", normalized_path)

            raw = path.read_text(encoding="utf-8")
            self.assertEqual(raw.count("\n"), 1)
            self.assertNotIn("\u2028", raw)
            self.assertIn("\\u2028", raw)
            self.assertEqual(json.loads(raw)["normalizedPath"], normalized_path)
            self.assertFalse(journal.has_full_marker())

    def test_appends_exactly_one_marker_after_capacity_is_exhausted(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "hits.jsonl"
            path.write_bytes(b"x" * MODULE.MAX_AUDIT_BYTES)
            journal = self.journal(path)

            journal.record("tbench_domain", "tbench.ai", "/tasks")
            size_with_marker = path.stat().st_size
            journal.record("tbench_domain", "tbench.ai", "/other")

            self.assertEqual(path.stat().st_size, size_with_marker)
            markers = [
                record
                for record in self.json_records(path)
                if record.get("ruleId") == "audit_truncated"
            ]
            self.assertEqual(len(markers), 1)

    def test_marks_a_record_that_would_cross_the_limit(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "hits.jsonl"
            path.write_bytes(b"{}\n" * 5)
            journal = self.journal(path, path.stat().st_size + 1)

            journal.record("tbench_domain", "tbench.ai", "/tasks")

            self.assertEqual(self.json_records(path)[-1]["ruleId"], "audit_truncated")
            self.assertTrue(journal.has_full_marker())

    def test_non_object_or_broken_tail_is_not_a_marker(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "hits.jsonl"
            for tail in ('123\n"x"\n', '{broken\n'):
                with self.subTest(tail=tail):
                    path.write_text(tail)
                    journal = self.journal(path)
                    self.assertFalse(journal.has_full_marker())
                    journal.mark_full()
                    self.assertTrue(journal.has_full_marker())

    @staticmethod
    def json_records(path: Path) -> list[dict[str, object]]:
        records = []
        for line in path.read_text().splitlines():
            if not line.startswith("{"):
                continue
            decoded = json.loads(line)
            if isinstance(decoded, dict):
                records.append(decoded)
        return records


if __name__ == "__main__":
    unittest.main()
