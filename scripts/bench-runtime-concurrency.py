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

"""Rotate release binaries through sequential concurrency workloads.

Example: scripts/bench-runtime-concurrency.py --output /tmp/concurrency \
    original=/path/to/original candidate=/path/to/candidate
Every stdout, stderr and command is retained in the new output directory.
"""

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import platform
import re
import shutil
import statistics
import subprocess
import sys
import tempfile
import time


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2) + "\n")


def name(value):
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*", value):
        raise ValueError(f"invalid label or case name: {value!r}")
    return value


def case(value):
    label, agents, calls, size, pattern = value.split(":")
    agents, calls, size = int(agents), int(calls), int(size)
    if agents <= 0 or calls <= 0 or size < 0 or pattern not in ("repeated", "unique"):
        raise ValueError(f"invalid case: {value}")
    return dict(name=name(label), agents=agents, calls_per_agent=calls,
                requested_bytes=size, content_pattern=pattern)


def metrics(report):
    usage = report.get("workload_process_usage") or {}
    return dict(batch_ms=report["write_elapsed_ms"],
                settlement_p95_ms=report["tool_settlements"]["p95_ms"],
                catalog_p95_ms=report["catalog"]["p95_ms"],
                history_p95_ms=report["history"]["p95_ms"],
                cpu_user_ms=usage.get("user_ms"), cpu_system_ms=usage.get("system_ms"),
                peak_rss_native_units=usage.get("peak_rss_native_units"),
                disk_bytes=report["disk_bytes"])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("candidates", nargs="+", metavar="LABEL=BINARY")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--runs", type=int, default=3)
    parser.add_argument("--case", action="append", metavar="NAME:AGENTS:CALLS:BYTES:PATTERN")
    args = parser.parse_args()
    if args.runs <= 0:
        parser.error("runs must be positive")
    try:
        candidates = [(name(label), Path(binary).resolve()) for label, binary in
                      (item.split("=", 1) for item in args.candidates)]
        cases = [case(value) for value in (args.case or [
            "short:16:20:65536:repeated", "long:16:200:65536:repeated",
            "unique:16:20:65536:unique"])]
        if len({label for label, _ in candidates}) != len(candidates):
            raise ValueError("candidate labels must be unique")
        if len({item["name"] for item in cases}) != len(cases):
            raise ValueError("case names must be unique")
        binaries = {}
        for label, binary in candidates:
            with binary.open("rb") as stream:
                binaries[label] = dict(path=str(binary), sha256=hashlib.file_digest(stream, "sha256").hexdigest())
    except (ValueError, OSError) as error:
        parser.error(str(error))
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    fixtures, samples = {}, {}
    manifest = dict(binaries=binaries, cases=cases, runs=args.runs, fixture_sha256=fixtures,
                    environment=dict(platform=platform.platform(), machine=platform.machine(),
                                     python=sys.version, cpu_count=os.cpu_count(), cwd=os.getcwd(),
                                     temporary_directory=tempfile.gettempdir(),
                                     variables={key: os.environ[key] for key in
                                                ("RUST_LOG", "RUST_BACKTRACE", "TOKIO_WORKER_THREADS") if key in os.environ}),
                    invocation=sys.argv, started_unix_seconds=time.time(),
                    rss_units="platform-native getrusage ru_maxrss", execution="sequential; rotating candidate order")
    write_json(output / "manifest.json", manifest)
    for repeat in range(args.runs):
        offset = repeat % len(candidates)
        order = candidates[offset:] + candidates[:offset]
        for config in cases:
            for label, binary in order:
                stem = output / f"{config['name']}-{repeat}-{label}"
                command = [str(binary), "--agents", str(config["agents"]),
                           "--calls", str(config["calls_per_agent"]), "--bytes", str(config["requested_bytes"]),
                           "--content-pattern", config["content_pattern"]]
                environment = dict(load=os.getloadavg() if hasattr(os, "getloadavg") else None,
                                   free_bytes=shutil.disk_usage(tempfile.gettempdir()).free)
                start = time.monotonic_ns()
                result = subprocess.run(command, text=True, capture_output=True, check=False)
                wall_ns = time.monotonic_ns() - start
                Path(f"{stem}.stdout.json").write_text(result.stdout)
                Path(f"{stem}.stderr.txt").write_text(result.stderr)
                write_json(Path(f"{stem}.run.json"), dict(command=command, case=config, candidate=label,
                           repeat=repeat, environment=environment, returncode=result.returncode, wall_ns=wall_ns))
                if result.returncode != 0:
                    raise RuntimeError(f"benchmark failed: {stem}")
                report = json.loads(result.stdout)
                if (report.get("profile") != "release" or report.get("read_errors") != []
                        or any(report.get(key) != value for key, value in config.items() if key != "name")
                        or report.get("tool_settlements", {}).get("samples") != config["agents"] * config["calls_per_agent"]):
                    raise RuntimeError(f"invalid workload report: {stem}")
                fixture = report.get("fixture_sha256")
                if not isinstance(fixture, str) or not fixture or fixtures.setdefault(config["name"], fixture) != fixture:
                    raise RuntimeError(f"missing or different fixture_sha256: {stem}")
                write_json(output / "manifest.json", manifest)
                values = metrics(report)
                if any(value is not None and (not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0)
                       for value in values.values()):
                    raise RuntimeError(f"invalid measurements: {stem}")
                samples.setdefault((config["name"], label), []).append(values)
                print(f"{config['name']} run={repeat} {label}: batch={values['batch_ms']:.3f}ms", flush=True)
    summary = []
    for (workload, label), runs in sorted(samples.items()):
        aggregated = {}
        for metric in runs[0]:
            values = [run[metric] for run in runs if run[metric] is not None]
            aggregated[metric] = dict(samples=len(values), values=values,
                                      median=statistics.median(values) if values else None,
                                      min=min(values) if values else None, max=max(values) if values else None)
        summary.append(dict(case=workload, candidate=label, runs=len(runs), metrics=aggregated))
    write_json(output / "summary.json", summary)


if __name__ == "__main__":
    main()
