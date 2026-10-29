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
"""Alternate retained release test executables; preserve work and timing evidence."""
import argparse
import json
import os
from pathlib import Path
import re
import statistics
import subprocess
import time

PRUNE = re.compile(
    r"prune-bench shape=(\S+) turns=(\d+) archived=(true|false) sample=(\d+) "
    r"ms=([\d.]+) candidates=(\d+) projection_bytes=(\d+) errors=(\d+)"
)


def records(kind, output):
    if kind == "prune":
        return [dict(shape=m[1], history_turns=int(m[2]), archived=m[3] == "true",
                     prune_ms=float(m[5]), candidates=int(m[6]),
                     projection_bytes=int(m[7]), errors=int(m[8]))
                for m in PRUNE.finditer(output)]
    result = []
    for line in output.splitlines():
        if line.startswith('{'):
            row = json.loads(line)
            if row.get("benchmark") in ("engine_long_history", "archive_context",
                                        "long_history_preparation", "long_history_window", "long_history_responsiveness",
                                        "one_invocation_transcript", "executor_invocation_transcript") and not row.get("summary"):
                if kind == "context":
                    row["history_turns"] = row["archived_count"]
                elif kind in ("transcript", "executor"):
                    row["history_turns"] = row["model_steps" if kind == "transcript" else "tool_calls"]
                result.append(row)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--kind", choices=["prune", "engine", "context", "responsive", "transcript", "executor"], required=True)
    parser.add_argument("--baseline", type=Path, required=True)
    parser.add_argument("--candidate", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--runs", type=int, default=5)
    parser.add_argument("--sizes", default="250,1000")
    parser.add_argument("--checkpoint", action="store_true")
    args = parser.parse_args()
    if args.runs < 5:
        parser.error("comparison requires at least five alternating pairs")
    if args.checkpoint and args.kind != "engine":
        parser.error("--checkpoint applies to the engine harness")
    args.output.mkdir(parents=True, exist_ok=True)
    environment = os.environ.copy()
    prefix = {"prune": "MAKA_PRUNE_BENCH", "engine": "MAKA_ENGINE_PERF",
              "context": "MAKA_CONTEXT_BENCH", "responsive": "MAKA_RESPONSIVENESS",
              "transcript": "MAKA_TRANSCRIPT_BENCH", "executor": "MAKA_EXECUTOR_BENCH"}[args.kind]
    if args.kind != "responsive":
        suffix = {"context": "_ARCHIVES", "transcript": "_STEPS", "executor": "_STEPS"}.get(args.kind, "_TURNS")
        environment[prefix + suffix] = args.sizes
    environment[prefix + "_REPETITIONS"] = "1"
    if args.kind == "engine":
        environment[prefix + "_CHECKPOINT"] = str(int(args.checkpoint))
    test = {"prune": "archive::performance::long_history_prune",
            "engine": "long_task_perf::engine_long_history",
            "context": "archive::context_performance::archive_heavy_context",
            "responsive": "long_task_responsiveness::long_history_responsiveness",
            "transcript": "transcript_index_tests::performance::one_invocation_transcript",
            "executor": "transcript_index_tests::performance_executor::executor_invocation_transcript"}[args.kind]
    evidence = {"kind": args.kind, "sizes": None if args.kind == "responsive" else args.sizes, "checkpoint": args.checkpoint,
                "runs": args.runs, "cpu_count": os.cpu_count(),
                "load_average": list(os.getloadavg()),
                "environment": {k: v for k, v in environment.items() if k.startswith(prefix)},
                "samples": [], "failures": []}
    result_file = args.output / "results.json"
    groups = {}
    expected_work = None
    for pair in range(args.runs):
        for label, binary in [("baseline", args.baseline), ("candidate", args.candidate)]:
            command = [str(binary.resolve()), test, "--ignored", "--exact", "--nocapture"]
            started = time.monotonic()
            process = subprocess.run(command, env=environment, text=True,
                                     stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
            output = args.output / f"{pair + 1:02d}-{label}.log"
            output.write_text(process.stdout)
            rows = records(args.kind, process.stdout)
            if process.returncode or not rows or any(row["errors"] for row in rows):
                evidence["failures"].append({"pair": pair + 1, "label": label,
                                            "exit_code": process.returncode, "log": str(output)})
                result_file.write_text(json.dumps(evidence, indent=2) + "\n")
                raise SystemExit(f"benchmark failed; inspect {output}")
            if args.kind == "responsive":
                evidence["sizes"] = ",".join(map(str, sorted({row["history_turns"] for row in rows})))
            work = [{key: value for key, value in row.items()
                     if not key.endswith("_ms") and key not in
                     ("repetition", "database_bytes", "database_wal_bytes", "fixture_cached")}
                    for row in rows]
            if expected_work is None:
                expected_work = work
            elif work != expected_work:
                evidence["failures"].append({"pair": pair + 1, "label": label,
                                            "reason": "completed work differs", "log": str(output)})
                result_file.write_text(json.dumps(evidence, indent=2) + "\n")
                raise SystemExit(f"completed work differs; inspect {output}")
            for row in rows:
                sample = dict(row, pair=pair + 1, revision=label)
                evidence["samples"].append(sample)
                key = (label, row["history_turns"], row.get("shape", row.get("phase", row.get("benchmark", "engine"))),
                       row.get("archived", args.checkpoint))
                groups.setdefault(key, []).append(row)
            result_file.write_text(json.dumps(evidence, indent=2) + "\n")
            print(f"pair {pair + 1}/{args.runs} {label}: {len(rows)} verified cases "
                  f"({time.monotonic() - started:.1f}s including setup)", flush=True)
    summary = []
    for key, rows in groups.items():
        metrics = {}
        for metric in ["prune_ms", "context_ms", "request_receipt_ms", "engine_completion_ms",
                       "transcript_prepare_ms", "first_page_ms", "stop_ms", "concurrent_history_ms",
                       "store_open_ms", "cancel_at_ms"]:
            if metric in rows[0]:
                values = [row[metric] for row in rows]
                metrics[metric] = dict(n=len(values), median=statistics.median(values),
                                       minimum=min(values), maximum=max(values))
        summary.append(dict(revision=key[0], history_turns=key[1], shape=key[2],
                            archived_or_checkpoint=key[3], metrics=metrics))
    evidence["summary"] = summary
    result_file.write_text(json.dumps(evidence, indent=2) + "\n")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
