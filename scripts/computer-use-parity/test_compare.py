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
"""Synthetic comparator tests; these do not exercise a desktop or establish parity."""

import copy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import compare


class ComparisonTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        root = Path(self.temporary.name)
        self.manifest = root / "cases.json"
        self.manifest.write_text(json.dumps({
            "platform_architectures": {"linux": ["x64"]},
            "cases": [{"id": "fixture.selection", "platforms": ["linux"], "oracles": ["text", "events"]}],
        }), encoding="utf-8")
        self.paths = {role: root / role / "run.json" for role in ("reference", "candidate")}
        self.records = {}
        for role, path in self.paths.items():
            path.parent.mkdir()
            evidence = path.with_name("effects.json")
            evidence.write_text('{"fixture_text":"안녕 🙂","input_events":1}\n', encoding="utf-8")
            self.records[role] = {
                "role": role, "run_id": role, "recorded_at": "2026-10-26T00:00:00+00:00",
                "platform": "linux", "architecture": "x64", "isolation": "container",
                "emulation": "none", "command": ["fixture-runner", "--selection"], "cwd": "/fixture",
                "suite_exit_code": 0, "fixture_sha256": "a" * 64,
                "manifest_sha256": compare.digest(self.manifest),
                "policy": {"sandbox": "fixture-policy", "approval": "fixture-app-only"},
                "subject": {"name": role, "version": "observed-fixture-version", "runtime": "fixture-runtime",
                            "artifacts": [{"name": "fixture-executable", "sha256": "b" * 64}]},
                "cases": {"fixture.selection": {
                    "status": "observed", "outcome": "success",
                    "effects": {"text": "안녕 🙂", "events": 1},
                    "evidence": [{"kind": "fixture-state", "path": evidence.name,
                                  "sha256": compare.digest(evidence)}],
                }},
            }

    def run_comparison(self):
        for role, path in self.paths.items():
            path.write_text(json.dumps(self.records[role]), encoding="utf-8")
        return compare.compare(self.manifest, self.paths["reference"], self.paths["candidate"])

    def test_matches_exact_unicode_effects_and_observed_refusals(self):
        self.assertEqual(self.run_comparison()["status"], "matched_for_recorded_scope")
        for record in self.records.values():
            record["cases"]["fixture.selection"]["outcome"] = "refused"
            record["cases"]["fixture.selection"]["effects"] = {"text": "unchanged", "events": 0}
        self.assertEqual(self.run_comparison()["matched_cases"], ["fixture.selection"])

    def test_missing_unsupported_and_unverified_cannot_match(self):
        candidate = self.records["candidate"]
        observed = copy.deepcopy(candidate["cases"])
        for status in (None, "unsupported", "unverified", "inventory-only"):
            with self.subTest(status=status):
                candidate["cases"] = copy.deepcopy(observed)
                if status is None:
                    candidate["cases"].clear()
                else:
                    candidate["cases"]["fixture.selection"]["status"] = status
                report = self.run_comparison()
                self.assertEqual(report["status"], "different_or_unverified")
                self.assertFalse(report["matched_cases"])

    def test_semantic_effect_difference_is_reported(self):
        self.records["candidate"]["cases"]["fixture.selection"]["effects"]["text"] = "안녕"
        self.assertEqual(self.run_comparison()["errors"], ["fixture.selection: outcome or fixture effects differ"])

    def test_boolean_is_not_a_numeric_event_count(self):
        self.records["candidate"]["cases"]["fixture.selection"]["effects"]["events"] = True
        self.assertEqual(self.run_comparison()["status"], "different_or_unverified")

    def test_omitted_or_additional_oracle_is_not_ignored(self):
        effects = self.records["candidate"]["cases"]["fixture.selection"]["effects"]
        for changed in ({"text": "안녕 🙂"}, dict(effects, hidden_recipient="wrong-window")):
            self.records["candidate"]["cases"]["fixture.selection"]["effects"] = changed
            self.assertEqual(self.run_comparison()["status"], "different_or_unverified")

    def test_missing_or_modified_runtime_evidence_fails(self):
        attachment = self.paths["candidate"].with_name("effects.json")
        attachment.write_text("tampered\n", encoding="utf-8")
        self.assertIn("evidence digest mismatch", " ".join(self.run_comparison()["errors"]))
        attachment.unlink()
        self.assertIn("evidence is absent", " ".join(self.run_comparison()["errors"]))

    def test_reused_capture_or_different_environment_fails(self):
        self.records["candidate"]["run_id"] = "reference"
        self.records["candidate"]["architecture"] = "arm64"
        self.records["candidate"]["isolation"] = "personal-desktop"
        errors = self.run_comparison()["errors"]
        self.assertIn("capture records must have distinct run IDs", errors)
        self.assertIn("architecture differs between capture records", errors)
        self.assertIn("candidate: an isolated desktop environment is required", errors)

    def test_duplicate_json_keys_cannot_hide_an_observation(self):
        self.paths["candidate"].write_text('{"cases":{},"cases":{"fixture.selection":{}}}', encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "duplicate JSON key"):
            compare.load(self.paths["candidate"])

    def test_evidence_cannot_escape_record_directory(self):
        evidence = self.records["candidate"]["cases"]["fixture.selection"]["evidence"][0]
        evidence["path"] = "../reference/effects.json"
        self.assertIn("evidence is absent or outside", " ".join(self.run_comparison()["errors"]))

    def test_cli_reports_observed_scope_and_exit_status(self):
        self.run_comparison()
        report_path = self.manifest.with_name("comparison.json")
        command = [sys.executable, str(Path(compare.__file__)), str(self.paths["reference"]),
                   str(self.paths["candidate"]), "--manifest", str(self.manifest), "--report", str(report_path)]
        result = subprocess.run(command, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(report_path.read_text(encoding="utf-8"))
        self.assertEqual(report["scope"]["case_ids"], ["fixture.selection"])
        self.assertEqual(report["records"]["candidate"]["command"], ["fixture-runner", "--selection"])
        before = report_path.read_bytes()
        self.assertEqual(subprocess.run(command, capture_output=True).returncode, 2)
        self.assertEqual(report_path.read_bytes(), before)
        command.append("--overwrite")
        self.records["candidate"]["cases"].clear()
        self.run_comparison()
        self.assertEqual(subprocess.run(command, capture_output=True).returncode, 1)
        self.paths["candidate"].unlink()
        result = subprocess.run(command, capture_output=True, text=True)
        self.assertEqual(result.returncode, 2)
        self.assertIn("Invalid capture input", result.stderr)

    def test_report_cannot_replace_captures_manifest_or_evidence(self):
        self.run_comparison()
        evidence = self.paths["candidate"].with_name("effects.json")
        for protected in (self.manifest, self.paths["reference"], self.paths["candidate"], evidence):
            with self.subTest(protected=protected):
                before = protected.read_bytes()
                with self.assertRaisesRegex(ValueError, "overwrite an input"):
                    compare.compare(self.manifest, self.paths["reference"], self.paths["candidate"], protected)
                self.assertEqual(protected.read_bytes(), before)
        alias = self.manifest.with_name("hard-linked-evidence.json")
        alias.hardlink_to(evidence)
        with self.assertRaisesRegex(ValueError, "overwrite an input"):
            compare.compare(self.manifest, self.paths["reference"], self.paths["candidate"], alias)


if __name__ == "__main__":
    unittest.main()
