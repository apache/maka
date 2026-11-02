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


"""Export CI job/step timings using gh; keep runner queue and DAG waiting separate."""

import argparse
import concurrent.futures
import csv
import json
import re
import statistics
import subprocess
from collections import defaultdict
from datetime import datetime
from pathlib import Path


def gh(*args):
    return json.loads(subprocess.check_output(["gh", *args], text=True))


def seconds(start, end):
    if not start or not end:
        return 0
    return max(0, (datetime.fromisoformat(end) - datetime.fromisoformat(start)).total_seconds())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", default="apache/maka")
    parser.add_argument("--branch", default="rust-preview")
    parser.add_argument("--limit", type=int, default=50)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    runs = gh("run", "list", "--repo", args.repo, "--branch", args.branch,
              "--limit", str(args.limit), "--json",
              "databaseId,workflowName,headSha,status,conclusion,createdAt,updatedAt,url")
    (args.output / "runs.json").write_text(json.dumps(runs, indent=2) + "\n")

    def jobs(run):
        path = args.output / f"{run['databaseId']}.json"
        pages = gh("api", f"repos/{args.repo}/actions/runs/{run['databaseId']}/jobs?per_page=100",
                   "--paginate", "--slurp")
        path.write_text(json.dumps(pages, indent=2) + "\n")
        for page in pages:
            for job in page["jobs"]:
                if job["name"].startswith("root-tests") and job["conclusion"] in {"success", "failure"}:
                    log = args.output / f"job-{job['id']}.log"
                    if not log.exists():
                        with log.open("wb") as file:
                            subprocess.run(["gh", "api", "--allow-escape-sequences",
                                            f"repos/{args.repo}/actions/jobs/{job['id']}/logs"],
                                           stdout=file, check=True)
                    text = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", log.read_text())
                    summary = re.search(r"Summary \[\s*([0-9.]+)s\]\s+(\d+) tests run: (\d+) passed", text)
                    if summary:
                        job["test_seconds"] = float(summary[1])
                        job["test_count"] = int(summary[2])
                        job["passed"] = int(summary[3])
        return run, [job for page in pages for job in page["jobs"]]

    rows = []
    step_rows = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        for run, entries in pool.map(jobs, runs):
            for job in entries:
                if job["status"] != "completed" or not job["started_at"]:
                    continue
                execution = 0
                for step in job["steps"]:
                    duration = seconds(step.get("started_at"), step.get("completed_at"))
                    # Compilation, artifact transfer and teardown count as preparation;
                    # execution means the actual verification step, not pure test CPU.
                    phase = "execution" if step["name"].startswith((
                        "Verify selected suites", "Execute the produced test partition",
                        "Run node scripts/ci.mjs run", "Run cargo test", "Run cargo nextest",
                        "Run npm test", "Check native computer-use library",
                    )) or (step["name"] == "Compile selected suites" and
                           (job["name"] == "clippy" or job["name"].startswith("native-"))) else "preparation"
                    if phase == "execution":
                        execution += duration
                    step_rows.append(dict(run=run["databaseId"], job=job["name"],
                                          step=step["name"], phase=phase, seconds=duration))
                # nextest archive extraction lives inside the replay step; its own
                # summary isolates actual test execution from that preparation.
                execution = job.get("test_seconds", execution)
                total = seconds(job["started_at"], job["completed_at"])
                rows.append(dict(run=run["databaseId"], workflow=run["workflowName"],
                                 sha=run["headSha"], run_result=run["conclusion"],
                                 job=job["name"], result=job["conclusion"],
                                 dependency_s=seconds(run["createdAt"], job["created_at"]),
                                 queue_s=seconds(job["created_at"], job["started_at"]),
                                 preparation_s=max(0, total-execution), execution_s=execution,
                                 total_s=total, test_count=job.get("test_count"),
                                 passed=job.get("passed"), url=job["html_url"]))
    for name, data in [("jobs.csv", rows), ("steps.csv", step_rows)]:
        if data:
            with (args.output / name).open("w", newline="") as file:
                writer = csv.DictWriter(file, fieldnames=data[0])
                writer.writeheader()
                writer.writerows(data)
    groups = defaultdict(list)
    for row in rows:
        if row["result"] == "success":
            groups[row["job"]].append(row)
    print(f"{len(runs)} runs; {len(rows)} completed jobs (cancelled jobs kept in CSV)")
    print("job | n | pre-job wait (scheduling/needs) | runner queue | preparation | execution | total (median seconds)")
    for name, data in sorted(groups.items()):
        values = [round(statistics.median(row[key] for row in data)) for key in
                  ["dependency_s", "queue_s", "preparation_s", "execution_s", "total_s"]]
        print(f"{name} | {len(data)} | " + " | ".join(map(str, values)))


if __name__ == "__main__":
    main()
