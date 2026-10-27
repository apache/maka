#!/usr/bin/env python3
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
"""Compare independently captured computer-use effects; never execute desktop input."""

import argparse
import hashlib
import json
from pathlib import Path
import re
import sys


MANIFEST = Path(__file__).with_name("cases.json")
SHA256 = re.compile(r"[0-9a-f]{64}\Z")
EVIDENCE_KINDS = {
    "fixture-state", "event-trace", "screen-capture", "audio-capture",
    "authorization-trace", "repl-transcript",
}


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def load(path):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError(f"{path}: duplicate JSON key {key!r}")
            result[key] = value
        return result

    def invalid_number(value):
        raise ValueError(f"{path}: non-finite JSON number {value}")

    return json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=unique, parse_constant=invalid_number)


def nonempty(value):
    return isinstance(value, str) and bool(value.strip())


def validate_record(record, path, role, manifest_sha256, cases):
    errors = []
    files = set()

    def require(condition, message):
        if not condition:
            errors.append(f"{role}: {message}")

    if not isinstance(record, dict):
        return [f"{role}: record must be an object"], files
    for key in ("run_id", "recorded_at", "cwd", "fixture_sha256"):
        require(nonempty(record.get(key)), f"{key} is required")
    require(record.get("role") == role, f"role must be {role}")
    require(record.get("manifest_sha256") == manifest_sha256, "manifest identity differs")
    require(bool(SHA256.fullmatch(record.get("fixture_sha256", ""))), "fixture_sha256 is invalid")
    require(record.get("isolation") in ("container", "virtual-machine", "dedicated-desktop-session"),
            "an isolated desktop environment is required")
    require(nonempty(record.get("emulation")), "emulation must name the emulator or 'none'")
    require(record.get("suite_exit_code") == 0 and type(record.get("suite_exit_code")) is int,
            "the capture suite did not exit successfully")
    command = record.get("command")
    require(isinstance(command, list) and bool(command) and all(map(nonempty, command)),
            "command must contain the exact executed argv")
    policy = record.get("policy")
    require(isinstance(policy, dict) and all(nonempty(policy.get(k)) for k in ("sandbox", "approval")),
            "sandbox and approval policy must be recorded")
    subject = record.get("subject", {})
    require(isinstance(subject, dict) and all(nonempty(subject.get(k)) for k in ("name", "version", "runtime")),
            "subject name, observed version and runtime identity are required")
    artifacts = subject.get("artifacts") if isinstance(subject, dict) else None
    require(isinstance(artifacts, list) and bool(artifacts), "subject artifact identities are required")
    for artifact in artifacts if isinstance(artifacts, list) else []:
        require(isinstance(artifact, dict) and nonempty(artifact.get("name"))
                and isinstance(artifact.get("sha256"), str) and bool(SHA256.fullmatch(artifact["sha256"])),
                "invalid subject artifact identity")
    rows = record.get("cases")
    if not isinstance(rows, dict):
        return errors + [f"{role}: cases must be an object"], files
    require(not (set(rows) - set(cases)), "record contains cases outside the selected manifest scope")
    root = path.resolve().parent
    for case_id, case in cases.items():
        row = rows.get(case_id)
        if not isinstance(row, dict) or row.get("status") != "observed":
            errors.append(f"{role}/{case_id}: missing or unobserved; an API refusal must be recorded as observed")
            continue
        require(row.get("outcome") in ("success", "refused", "partial", "outcome_unknown"),
                f"{case_id}: missing observed outcome")
        effects = row.get("effects")
        require(isinstance(effects, dict) and set(effects) == set(case["oracles"]),
                f"{case_id}: effects must contain exactly {case['oracles']}")
        evidence = row.get("evidence")
        if not isinstance(evidence, list) or not evidence:
            errors.append(f"{role}/{case_id}: independent runtime evidence is required")
            continue
        for item in evidence:
            if not isinstance(item, dict) or item.get("kind") not in EVIDENCE_KINDS:
                errors.append(f"{role}/{case_id}: invalid runtime evidence kind")
                continue
            relative = item.get("path")
            if not nonempty(relative) or Path(relative).is_absolute():
                errors.append(f"{role}/{case_id}: evidence path must be relative to its record")
                continue
            attachment = (root / relative).resolve()
            if not attachment.is_relative_to(root) or not attachment.is_file():
                errors.append(f"{role}/{case_id}: evidence is absent or outside its record directory")
                continue
            files.add(attachment)
            if item.get("sha256") != digest(attachment):
                errors.append(f"{role}/{case_id}: evidence digest mismatch for {relative}")
    return errors, files


def compare(manifest_path, reference_path, candidate_path, report_path=None):
    manifest = load(manifest_path)
    manifest_sha256 = digest(manifest_path)
    reference, candidate = load(reference_path), load(candidate_path)
    if not isinstance(reference, dict) or not isinstance(candidate, dict):
        raise ValueError("capture records must be objects")
    platform = reference.get("platform")
    architecture = reference.get("architecture")
    if platform not in manifest["platform_architectures"]:
        raise ValueError("reference platform is outside the manifest")
    if architecture not in manifest["platform_architectures"][platform]:
        raise ValueError("reference architecture is outside the manifest")
    cases = {case["id"]: case for case in manifest["cases"] if platform in case["platforms"]}
    if not cases or len({case["id"] for case in manifest["cases"]}) != len(manifest["cases"]):
        raise ValueError("manifest must contain uniquely named cases and a nonempty selected scope")
    errors, reference_files = validate_record(reference, reference_path, "reference", manifest_sha256, cases)
    other_errors, candidate_files = validate_record(candidate, candidate_path, "candidate", manifest_sha256, cases)
    errors.extend(other_errors)
    for key in ("platform", "architecture", "fixture_sha256"):
        if reference.get(key) != candidate.get(key):
            errors.append(f"{key} differs between capture records")
    if reference.get("run_id") == candidate.get("run_id"):
        errors.append("capture records must have distinct run IDs")
    if reference_files & candidate_files:
        errors.append("reference and candidate reuse the same evidence file")
    if report_path is not None:
        protected = reference_files | candidate_files | {manifest_path, reference_path, candidate_path}
        for source in protected:
            if report_path.resolve() == source.resolve() or (report_path.exists() and source.samefile(report_path)):
                raise ValueError("report destination would overwrite an input or its runtime evidence")
    matched = []
    if not errors:
        for case_id in cases:
            left, right = reference["cases"][case_id], candidate["cases"][case_id]
            # JSON encoding keeps booleans distinct from numbers and compares
            # the complete declared effects, including observed refusals.
            fields = lambda row: json.dumps([row["outcome"], row["effects"]], sort_keys=True, allow_nan=False)
            if fields(left) != fields(right):
                errors.append(f"{case_id}: outcome or fixture effects differ")
            else:
                matched.append(case_id)
    return {
        "status": "different_or_unverified" if errors else "matched_for_recorded_scope",
        "scope": {"platform": platform, "architecture": architecture,
                  "manifest_sha256": manifest_sha256, "case_ids": list(cases)},
        "reference_run": reference.get("run_id"), "candidate_run": candidate.get("run_id"),
        "records": {
            role: {"sha256": digest(path), "subject": record.get("subject"),
                   "isolation": record.get("isolation"), "emulation": record.get("emulation"),
                   "command": record.get("command"), "cwd": record.get("cwd"), "policy": record.get("policy")}
            for role, path, record in (("reference", reference_path, reference),
                                       ("candidate", candidate_path, candidate))
        },
        "matched_cases": matched, "errors": errors,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("reference", type=Path)
    parser.add_argument("candidate", type=Path)
    parser.add_argument("--manifest", type=Path, default=MANIFEST)
    parser.add_argument("--report", type=Path)
    parser.add_argument("--overwrite", action="store_true", help="replace an existing output report, never an input or evidence file")
    args = parser.parse_args()
    try:
        report = compare(args.manifest, args.reference, args.candidate, args.report)
        output = json.dumps(report, indent=2, allow_nan=False) + "\n"
        if args.report:
            with args.report.open("w" if args.overwrite else "x", encoding="utf-8") as stream:
                stream.write(output)
    except (OSError, ValueError, KeyError, TypeError) as error:
        parser.exit(2, f"Invalid capture input: {error}\n")
    print(output, end="")
    return 0 if not report["errors"] else 1


if __name__ == "__main__":
    sys.exit(main())
