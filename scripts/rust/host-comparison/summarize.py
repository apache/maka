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
"""Reduce raw offline Host receipts; preserve failed runs and measurement coverage."""

import argparse
import hashlib
import json
import statistics
from itertools import pairwise
from pathlib import Path


def percentile(values, fraction):
    if not values:
        return None
    values = sorted(values)
    point = (len(values) - 1) * fraction
    lower = int(point)
    return values[lower] + (values[min(lower + 1, len(values) - 1)] - values[lower]) * (
        point - lower
    )


def distribution(values):
    return {
        "count": len(values),
        "min": min(values) if values else None,
        "p50": percentile(values, 0.5),
        "p95": percentile(values, 0.95),
        "p99": percentile(values, 0.99),
        "max": max(values) if values else None,
    }


def process_metrics(samples, key, ticks):
    rows = [
        (sample["time"], sample["processes"][key])
        for sample in samples
        if key in sample["processes"] and not sample["processes"][key].get("gone")
    ]
    if not rows:
        return None
    elapsed = rows[-1][0] - rows[0][0]
    cpu_seconds, interval_cpu = 0, []
    for (before_time, before), (after_time, after) in pairwise(rows):
        if (before["pid"], before["startTicks"]) != (after["pid"], after["startTicks"]):
            continue
        delta = (
            after["utime"] + after["stime"] - before["utime"] - before["stime"]
        ) / ticks
        cpu_seconds += delta
        if after_time > before_time:
            interval_cpu.append(100 * delta / (after_time - before_time))
    io_rows = [(t, row) for t, row in rows if "ioBytesAndCalls" in row]
    io_delta = {}
    for (_, before), (_, after) in pairwise(io_rows):
        if (before["pid"], before["startTicks"]) != (after["pid"], after["startTicks"]):
            continue
        for field in before["ioBytesAndCalls"].keys() & after["ioBytesAndCalls"].keys():
            io_delta[field] = io_delta.get(field, 0) + max(
                0, after["ioBytesAndCalls"][field] - before["ioBytesAndCalls"][field]
            )
    return {
        "sampleCount": len(rows),
        "sampledSeconds": elapsed,
        "cpuSeconds": cpu_seconds,
        "meanCpuPercentOneCore": 100 * cpu_seconds / elapsed if elapsed else None,
        "intervalCpuPercentOneCore": distribution(interval_cpu),
        "rssMiB": distribution([row["rssKiB"] / 1024 for _, row in rows]),
        "pssMiB": distribution(
            [row["pssKiB"] / 1024 for _, row in rows if "pssKiB" in row]
        ),
        "peakSwapMiB": max(row["swapKiB"] for _, row in rows) / 1024,
        "peakThreads": max(row["threads"] for _, row in rows),
        "peakFds": max(row["fds"] for _, row in rows),
        "ioCounterDeltas": io_delta,
        "ioSampledSeconds": io_rows[-1][0] - io_rows[0][0]
        if len(io_rows) > 1
        else None,
    }


def reduce_run(directory):
    value = json.loads((directory / "result.json").read_text())
    manifest = (
        json.loads((directory / "manifest.json").read_text())
        if (directory / "manifest.json").exists()
        else {}
    )
    samples = value["samples"]
    ticks = value.get("clockTicksPerSecond", manifest.get("clockTicksPerSecond"))
    info = value.get("scale", value.get("baseline", {}))
    cohort = {
        "source": manifest.get("gitCommit"),
        "files": {
            Path(path).name: digest
            for path, digest in manifest.get("fileSha256", {}).items()
        },
        "options": {
            key: option
            for key, option in manifest.get("options", {}).items()
            if key not in {"output", "rust_checkout", "ts_checkout"}
        },
        "environment": {
            key: manifest.get(key)
            for key in ("python", "node", "platform", "cpuCount", "clockTicksPerSecond")
        },
    }
    summary = {
        "run": directory.name,
        "kind": value["kind"],
        "mode": manifest.get("options", {}).get(
            "mode",
            "background"
            if "scale" in value
            else "baseline"
            if "baseline" in value
            else "smoke",
        ),
        "passed": value.get("passed", False),
        "error": value.get("error"),
        "cleanupErrors": value.get("cleanupErrors", []),
        "telemetryErrors": value.get("telemetryErrors", []),
        "source": manifest.get("gitCommit"),
        "cohort": cohort,
        "cohortSha256": hashlib.sha256(
            json.dumps(cohort, sort_keys=True).encode()
        ).hexdigest(),
        "manifest": str(directory / "manifest.json") if manifest else None,
        "started": value["started"],
        "finished": value["finished"],
        "wallSeconds": value["finished"] - value["started"],
        "providerRequests": len(value["providerRequests"]),
        "providerErrors": len(value["providerErrors"]),
        "providerPeak": value["providerPeak"],
        "resources": {
            key: process_metrics(samples, key, ticks)
            for key in ("host", "adapter", "providerController")
        },
        "phases": [],
        "providerWakeLatenessMs": distribution(
            [
                r["maxWakeLatenessMs"]
                for r in value["providerRequests"]
                if "maxWakeLatenessMs" in r
            ]
        ),
        "rampPrefixChars": distribution(
            [r.get("rampPrefixChars", 0) for r in value["providerRequests"]]
        ),
        "providerOutputBytes": sum(
            r.get("outputBytes", 0) for r in value["providerRequests"]
        ),
        "samplingMs": distribution(
            [r["samplingMs"] for r in samples if "samplingMs" in r]
        ),
    }
    phases = info.get("phases", [])
    for index, phase in enumerate(phases):
        end = (
            phases[index + 1]["time"]
            if index + 1 < len(phases)
            else samples[-1]["time"]
            if samples
            else phase["time"]
        )
        selected = [
            sample for sample in samples if phase["time"] <= sample["time"] < end
        ]
        summary["phases"].append(
            {
                "name": phase["phase"],
                "startedMonotonic": phase["time"],
                "durationSeconds": max(0, end - phase["time"]),
                "resources": {
                    key: process_metrics(selected, key, ticks)
                    for key in ("host", "adapter", "providerController")
                },
            }
        )
    if "scale" in value:
        keys = (
            "requested",
            "created",
            "admitted",
            "admittedAtBarrier",
            "activeAtBarrier",
            "completed",
            "verified",
            "unknownAdmissionCanonicalVerified",
            "unconfirmedTerminalCanonicalVerified",
            "notSubmittedOrAdmitted",
            "barrierReachedAll",
            "rampLimitSeconds",
            "resourceStop",
            "scopes",
            "admissionConcurrency",
            "observer",
        )
        summary["scale"] = {key: info[key] for key in keys if key in info}
        summary["scale"]["errors"] = {
            key: {"count": len(rows), "examples": rows[:3]}
            for key, rows in info.items()
            if key.endswith("Errors")
        }
        summary["scale"]["providerRequestsWithoutAdmissionReply"] = (
            len(info.get("providerRequestsWithoutAdmissionReply", []))
            if "providerRequestsWithoutAdmissionReply" in info
            else None
        )
        admissions = [a for a in info.get("admissions", []) if a is not None]
        summary["scale"]["admissionReplyMs"] = distribution(
            [1000 * (a["admitted"] - a["started"]) for a in admissions]
        )
        times = {row["phase"]: row["time"] for row in phases}
        for name, first, last in [
            ("createSeconds", "create_start", "resident_idle_start"),
            ("rampSeconds", "active_ramp_start", "active_hold_start"),
            (
                "releaseToTerminalChecksFinishedSeconds",
                "stream_release",
                "terminal_observed",
            ),
            ("releaseToProviderDrainedSeconds", "stream_release", "provider_drained"),
            ("observerAttachSeconds", "provider_drained", "observer_ready"),
            ("terminalChecksSeconds", "observer_ready", "terminal_observed"),
            ("canonicalVerificationSeconds", "terminal_observed", "canonical_verified"),
        ]:
            if first in times and last in times:
                summary["scale"][name] = times[last] - times[first]
        # The phase is emitted when checks finish, including when every query
        # fails. Only label it an observation of all admitted terminals if true.
        if (
            info.get("admitted", 0) > 0
            and info.get("completed") == info["admitted"]
            and not info.get("terminalErrors")
        ):
            for observed, checked in (
                (
                    "releaseToTerminalObservedSeconds",
                    "releaseToTerminalChecksFinishedSeconds",
                ),
                ("terminalObservationSeconds", "terminalChecksSeconds"),
            ):
                if checked in summary["scale"]:
                    summary["scale"][observed] = summary["scale"][checked]
    if "baseline" in value:
        summary["baseline"] = {key: row for key, row in info.items() if key != "phases"}
        stream = summary["baseline"].get("largeStream", {})
        if (
            "startedMs" in stream
            and stream.get("firstTextMs") is not None
            and stream.get("terminalMs") is not None
        ):
            stream["firstTextObservedMs"] = stream["firstTextMs"] - stream["startedMs"]
            stream["completionObservedMs"] = stream["terminalMs"] - stream["startedMs"]
        elif "firstVisibleMs" in stream and "completedMs" in stream:
            stream["firstTextObservedMs"] = stream["firstVisibleMs"]
            stream["completionObservedMs"] = stream["completedMs"]
    if (directory / "supplemental-metrics.jsonl").exists():
        extra = [
            json.loads(line)
            for line in (directory / "supplemental-metrics.jsonl")
            .read_text()
            .splitlines()
        ]
        summary["lateSupplementalCoverage"] = {
            "metadata": extra[0],
            "resources": {
                key: process_metrics(extra[1:], key, ticks)
                for key in (
                    "host",
                    "adapter",
                    "providerController",
                    "supplementalMonitor",
                )
            },
        }
    system = [sample for sample in samples if "system" in sample]
    if len(system) > 1:
        first, last = system[0], system[-1]
        elapsed = last["time"] - first["time"]
        summary["system"] = {
            "sampledSeconds": elapsed,
            "minimumAvailableMiB": min(row["availableKiB"] for row in samples) / 1024,
            "pressureStallPercent": {
                resource: {
                    level: 100
                    * (
                        float(last["system"]["pressure"][resource][level]["total"])
                        - float(first["system"]["pressure"][resource][level]["total"])
                    )
                    / 1e6
                    / elapsed
                    for level in first["system"]["pressure"][resource]
                }
                for resource in first["system"]["pressure"]
            },
            "swapPagesInDelta": last["system"]["vmstat"]["pswpin"]
            - first["system"]["vmstat"]["pswpin"],
            "swapPagesOutDelta": last["system"]["vmstat"]["pswpout"]
            - first["system"]["vmstat"]["pswpout"],
        }
    return summary


def grouped_formal(runs):
    groups = {}
    for run in runs:
        if "-formal-" not in run["run"] or not run["campaignSelected"]:
            continue
        groups.setdefault((run["kind"], run["mode"], run["cohortSha256"]), []).append(
            run
        )
    output = []
    for (kind, mode, cohort_hash), rows in sorted(groups.items()):

        def metric(name, getter, rows=rows):
            values = [getter(row) for row in rows if row["passed"]]
            values = [value for value in values if value is not None]
            return name, {
                "median": statistics.median(values),
                "min": min(values),
                "max": max(values),
                "runs": len(values),
            } if values else None

        metrics = [
            metric("hostPeakRssMiB", lambda r: r["resources"]["host"]["rssMiB"]["max"]),
            metric("hostCpuSeconds", lambda r: r["resources"]["host"]["cpuSeconds"]),
            metric("hostPeakPssMiB", lambda r: r["resources"]["host"]["pssMiB"]["max"]),
        ]
        if mode == "background":
            for key in (
                "createSeconds",
                "rampSeconds",
                "releaseToTerminalObservedSeconds",
                "canonicalVerificationSeconds",
            ):
                metrics.append(metric(key, lambda r, k=key: r["scale"][k]))
        else:
            for key, path in [
                ("largeStreamMs", ("largeStream", "completionObservedMs")),
                ("firstTextMs", ("largeStream", "firstTextObservedMs")),
                ("historyReadMs", ("historyRead", "controllerReadMs")),
                ("reopenAndReadMs", ("reopenAndReadMs",)),
            ]:

                def get(row, path=path):
                    value = row["baseline"]
                    for part in path:
                        value = value[part]
                    return value

                metrics.append(metric(key, get))
            for name, field, subfield in [
                ("idleHostRssMiB", "rssMiB", "p50"),
                ("idleHostPssMiB", "pssMiB", "p50"),
                ("idleHostCpuPercentOneCore", "meanCpuPercentOneCore", None),
            ]:

                def get(row, field=field, subfield=subfield):
                    value = next(p for p in row["phases"] if p["name"] == "idle_start")[
                        "resources"
                    ]["host"][field]
                    return value[subfield] if subfield else value

                metrics.append(metric(name, get))
            for name, field, subfield in [
                ("streamHostPeakRssMiB", "rssMiB", "max"),
                ("streamHostPeakPssMiB", "pssMiB", "max"),
                ("streamHostSampledCpuSeconds", "cpuSeconds", None),
                ("streamHostSampledSeconds", "sampledSeconds", None),
                ("streamHostSampleCount", "sampleCount", None),
            ]:

                def get(row, field=field, subfield=subfield):
                    host = next(
                        p for p in row["phases"] if p["name"] == "large_stream_start"
                    )["resources"]["host"]
                    if host is None:
                        return None
                    value = host[field]
                    return value[subfield] if subfield else value

                metrics.append(metric(name, get))
            metrics.append(
                metric(
                    "streamPhaseSeconds",
                    lambda row: next(
                        p for p in row["phases"] if p["name"] == "large_stream_start"
                    )["durationSeconds"],
                )
            )
        output.append(
            {
                "kind": kind,
                "mode": mode,
                "cohortSha256": cohort_hash,
                "runIds": [row["run"] for row in rows],
                "totalRuns": len(rows),
                "passedRuns": sum(r["passed"] for r in rows),
                "metrics": dict(metrics),
            }
        )
    return output


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("directory", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--campaign", type=Path)
    options = parser.parse_args()
    campaign_path = options.campaign or options.directory / "campaign-manifest.json"
    campaign = json.loads(campaign_path.read_text())
    planned = set(campaign["plannedRunIds"])
    if len(planned) != len(campaign["plannedRunIds"]):
        raise ValueError("Campaign has duplicate run IDs")
    frozen = campaign["harnessSha256"]
    if not frozen:
        raise ValueError("Campaign must identify frozen harness hashes")
    runs = []
    for path in sorted(options.directory.glob("*/result.json")):
        if not any(
            marker in path.parent.name
            for marker in ("-formal-", "background1000-", "background10000-")
        ):
            continue
        run = reduce_run(path.parent)
        exclusion = None
        if run["run"] not in planned:
            exclusion = "Run ID is not in the selected campaign"
        elif any(run["cohort"]["files"].get(k) != v for k, v in frozen.items()):
            exclusion = "Harness hashes do not match the selected campaign"
        run["campaignSelected"] = exclusion is None
        run["campaignExclusion"] = exclusion
        runs.append(run)
    options.output.write_text(
        json.dumps(
            {
                "notes": [
                    "CPU 100% means one logical core. Resource counter deltas cover sampled intervals, excluding unobserved startup and cleanup.",
                    "System PSI/disk/network counters include the whole machine. mainThreadContextSwitches are not process totals.",
                    "Capacity completion is publicly confirmed terminal state; provider completion means bytes written, not accepted. Admission timeouts may still execute.",
                    "Formal summaries keep failure counts; medians use successful rounds only and are incomplete unless all five pass.",
                    "Held SSE ramps use variable prefix chunk counts; release/drain timings are scenario observations, not pure Host throughput.",
                ],
                "campaign": {
                    "manifest": str(campaign_path),
                    "plannedRunIds": campaign["plannedRunIds"],
                    "missingRunIds": sorted(planned - {run["run"] for run in runs}),
                    "excludedRuns": [
                        {"run": run["run"], "reason": run["campaignExclusion"]}
                        for run in runs
                        if not run["campaignSelected"]
                    ],
                },
                "groups": grouped_formal(runs),
                "runs": runs,
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n"
    )
    print(json.dumps({"runs": len(runs), "output": str(options.output)}))
