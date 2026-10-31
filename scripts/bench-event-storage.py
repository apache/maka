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

"""Alternate frozen release binaries and validate their actual storage work.

Example: scripts/bench-event-storage.py --output /tmp/storage-comparison \
    original=/path/to/original candidate=/path/to/candidate
The output directory must be new. Datasets and every raw result are retained.
Reopened reads are OS-cache-warm, not cold-cache measurements.
"""

import argparse
import hashlib
import json
import os
import platform
from pathlib import Path
import shutil
import sqlite3
import statistics
import subprocess
import time


def storage_stats(directory):
    result = []
    for path in sorted((directory.resolve() / "root" / "runtime-partitions").glob("*.sqlite")):
        if not path.is_file():
            continue
        sidecars = {}
        for suffix in ("-wal", "-shm"):
            sidecar = path.with_name(path.name + suffix)
            sidecars[suffix] = sidecar.stat().st_size if sidecar.exists() else 0
        with sqlite3.connect(f"{path.as_uri()}?mode=ro", uri=True) as db:
            tables = {name for (name,) in db.execute("SELECT name FROM sqlite_schema WHERE type='table'")}
            directories = {}
            for table in ("context_semantic_rows", "context_semantic_fragments", "context_semantic_directory_children"):
                if table in tables:
                    columns = {row[1] for row in db.execute(f"PRAGMA table_info({table})")}
                    column = "directory_bytes" if "directory_bytes" in columns else "directory_json"
                    count, size = db.execute(f"SELECT COUNT(*), COALESCE(SUM(length(CAST({column} AS BLOB))),0) FROM {table}").fetchone()
                    directories[table] = dict(records=count, encoded_bytes=size)
            result.append(dict(file=path.name, file_bytes=path.stat().st_size,
                               wal_bytes=sidecars["-wal"], shm_bytes=sidecars["-shm"],
                               page_size=db.execute("PRAGMA page_size").fetchone()[0],
                               pages=db.execute("PRAGMA page_count").fetchone()[0],
                               free_pages=db.execute("PRAGMA freelist_count").fetchone()[0],
                               directories=directories,
                               bodies=(dict(zip(("records","raw_bytes","encoded_bytes"), db.execute("SELECT COUNT(*),COALESCE(SUM(raw_bytes),0),COALESCE(SUM(length(payload)),0) FROM event_bodies").fetchone())) if "event_bodies" in tables else None)))
    return result


def run(binary, directory, mode, events, body_bytes, iterations, body_pattern, operation="all"):
    command = [str(binary), "--database", str(directory), "--mode", mode,
               "--events", str(events), "--body-bytes", str(body_bytes),
               "--iterations", str(iterations), "--body-pattern", body_pattern]
    if operation != "all":
        command.extend(["--operation", operation])
    before = {"load": os.getloadavg(), "free_bytes": shutil.disk_usage(directory.parent).free}
    start = time.monotonic_ns()
    result = subprocess.run(command, check=True, text=True, capture_output=True)
    report = json.loads(result.stdout)
    if (report["errors"] or report["profile"] != "release"
            or report["completed_rows"] <= 0 or report["completed_bytes"] <= 0):
        raise RuntimeError(f"invalid or empty benchmark: {report}")
    if operation != "all" and report.get("operation") != operation:
        raise RuntimeError("binary does not support the requested operation")
    report.update(environment=before, wall_ns=time.monotonic_ns() - start,
                  stderr=result.stderr, command=command)
    report["storage_after_close"] = storage_stats(directory)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("candidates", nargs="+", metavar="LABEL=BINARY")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--runs", type=int, default=5)
    parser.add_argument("--iterations", type=int, default=20)
    parser.add_argument("--body-pattern", choices=("repeated", "entropy"), default="repeated")
    parser.add_argument("--operation", choices=("all", "prefix"), default="all")
    parser.add_argument("--case", action="append", metavar="NAME:EVENTS:BODY_BYTES")
    args = parser.parse_args()
    args.output = args.output.resolve()
    if args.runs < 5 or args.iterations < 1:
        parser.error("at least five runs and one iteration are required")
    candidates = [(label, Path(binary).resolve()) for label, binary in
                  (item.split("=", 1) for item in args.candidates)]
    if len({label for label, _ in candidates}) != len(candidates):
        parser.error("candidate labels must be unique")
    cases = [item.split(":") for item in (args.case or
             ["small:64:256", "large:4:2097152", "dense:128:16384"])]
    args.output.mkdir(parents=True, exist_ok=False)
    binaries = {}
    for label, binary in candidates:
        with binary.open("rb") as stream:
            binaries[label] = dict(path=str(binary), sha256=hashlib.file_digest(stream, "sha256").hexdigest())
    (args.output / "manifest.json").write_text(json.dumps(dict(
        binaries=binaries, platform=platform.platform(), cpu_count=os.cpu_count(),
        runs=args.runs, iterations=args.iterations, cases=cases, body_pattern=args.body_pattern,
        operation=args.operation,
        cache_state="one validation/warmup pass; steady state and OS-warm reopen"), indent=2) + "\n")
    summaries = {}
    fixtures = {}
    for repeat in range(args.runs):
        # Rotate order so each candidate sees a different position between runs.
        order = candidates[repeat % len(candidates):] + candidates[:repeat % len(candidates)]
        for case, event_count, body_size in cases:
            for label, binary in order:
                directory = args.output / f"{case}-{repeat}-{label}"
                for mode in ("create", "read"):
                    report = run(binary, directory, mode, int(event_count),
                                 int(body_size), args.iterations, args.body_pattern, args.operation)
                    fixture = report["fixture"]
                    previous = fixtures.setdefault(case, fixture)
                    if fixture != previous:
                        raise RuntimeError(f"canonical fixture changed in {case}/{label}")
                    report_path = args.output / f"{case}-{repeat}-{label}-{mode}.json"
                    report_path.write_text(json.dumps(report, indent=2) + "\n")
                    for operation, sample in report["samples"].items():
                        key = (case, mode, operation, label)
                        summaries.setdefault(key, []).append(sample)
                    print(f"{case} run={repeat} {label} {mode}: "
                          f"{report['completed_bytes']} bytes checked", flush=True)
    rows = []
    for (case, mode, operation, label), samples in sorted(summaries.items()):
        values = [sample["p50_ns"] for sample in samples]
        rows.append(dict(case=case, mode=mode, operation=operation, candidate=label,
                         runs=len(values), median_ns=statistics.median(values),
                         min_ns=min(values), max_ns=max(values), run_medians_ns=values,
                         run_p95_ns=[sample["p95_ns"] for sample in samples],
                         run_p99_ns=[sample["p99_ns"] for sample in samples]))
    (args.output / "summary.json").write_text(json.dumps(rows, indent=2) + "\n")


if __name__ == "__main__":
    main()
