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
"""Compare retained release Engine benchmarks with equal completed work."""
import argparse
import json
import os
from pathlib import Path
import statistics
import subprocess
import time


def records(output):
    rows = (json.loads(line) for line in output.splitlines() if line.startswith('{'))
    return [row for row in rows
            if row.get("benchmark") == "engine_long_history" and not row.get("summary")]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", type=Path, required=True)
    parser.add_argument("--candidate", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--runs", type=int, default=5)
    parser.add_argument("--sizes", default="250,1000")
    parser.add_argument("--checkpoint", action="store_true")
    args = parser.parse_args()
    if args.runs < 5:
        parser.error("comparison requires at least five alternating pairs")
    args.output.mkdir(parents=True, exist_ok=True)
    env = {**os.environ, "MAKA_ENGINE_PERF_TURNS": args.sizes,
           "MAKA_ENGINE_PERF_REPETITIONS": "1",
           "MAKA_ENGINE_PERF_CHECKPOINT": str(int(args.checkpoint))}
    evidence = {"sizes":args.sizes,"checkpoint":args.checkpoint,"runs":args.runs,
                "cpu_count":os.cpu_count(),"load_average":list(os.getloadavg()),
                "environment":{k:v for k,v in env.items() if k.startswith("MAKA_ENGINE_PERF")},
                "samples":[],"failures":[]}
    result_file = args.output / "results.json"
    expected_work = None
    groups = {}
    for pair in range(args.runs):
        for label, binary in [("baseline", args.baseline), ("candidate", args.candidate)]:
            started = time.monotonic()
            process = subprocess.run([
                str(binary.resolve()), "long_task_perf::engine_long_history",
                "--ignored", "--exact", "--nocapture",
            ], env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
            output = args.output / f"{pair + 1:02d}-{label}.log"
            output.write_text(process.stdout)
            rows = records(process.stdout)
            if process.returncode or not rows or any(row["errors"] for row in rows):
                evidence["failures"].append({"pair":pair + 1,"revision":label,
                                            "exit_code":process.returncode,"log":str(output)})
                result_file.write_text(json.dumps(evidence, indent=2) + "\n")
                raise SystemExit(f"benchmark failed; inspect {output}")
            work = [{key:value for key,value in row.items()
                     if not key.endswith("_ms") and key not in
                     ("repetition", "database_bytes", "database_wal_bytes", "fixture_cached")}
                    for row in rows]
            if expected_work is None:
                expected_work = work
            elif work != expected_work:
                evidence["failures"].append({"pair":pair + 1,"revision":label,
                                            "reason":"completed work differs","log":str(output)})
                result_file.write_text(json.dumps(evidence, indent=2) + "\n")
                raise SystemExit(f"completed work differs; inspect {output}")
            for row in rows:
                evidence["samples"].append(dict(row, pair=pair + 1, revision=label))
                groups.setdefault((label,row["history_turns"]), []).append(row)
            result_file.write_text(json.dumps(evidence, indent=2) + "\n")
            print(f"pair {pair + 1}/{args.runs} {label}: {len(rows)} verified cases "
                  f"({time.monotonic() - started:.1f}s including setup)", flush=True)
    summary = []
    for (label, turns), rows in groups.items():
        metrics = {}
        for metric in ("request_receipt_ms", "engine_completion_ms", "store_open_ms"):
            values = [row[metric] for row in rows]
            metrics[metric] = dict(n=len(values),median=statistics.median(values),
                                   minimum=min(values),maximum=max(values))
        summary.append(dict(revision=label,history_turns=turns,metrics=metrics))
    evidence["summary"] = summary
    result_file.write_text(json.dumps(evidence, indent=2) + "\n")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
