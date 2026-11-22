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
"""Linux benchmark telemetry; raw counters, monotonic and wall clocks."""

import json
import os
import time
from pathlib import Path


def numeric_file(path):
    try:
        return {
            k: int(v.strip().split()[0])
            for line in Path(path).read_text().splitlines()
            if ":" in line
            for k, v in [line.split(":", 1)]
        }
    except (OSError, ValueError):
        return {}


def system_sample():
    value = {
        "memoryKiB": numeric_file("/proc/meminfo"),
        "vmstat": {},
        "pressure": {},
        "network": {},
        "diskstats": [],
    }
    for line in Path("/proc/vmstat").read_text().splitlines():
        key, number = line.split()
        value["vmstat"][key] = int(number)
    stat = Path("/proc/stat").read_text().splitlines()
    value["cpuTicks"] = {
        row.split()[0]: [int(x) for x in row.split()[1:]]
        for row in stat
        if row.startswith("cpu")
    }
    value["scheduler"] = {
        row.split()[0]: int(row.split()[1])
        for row in stat
        if row.split()[0] in ("ctxt", "processes", "procs_running", "procs_blocked")
    }
    value["loadavg"] = Path("/proc/loadavg").read_text().strip()
    for name in ("cpu", "memory", "io"):
        try:
            value["pressure"][name] = {
                row.split()[0]: dict(item.split("=") for item in row.split()[1:])
                for row in Path("/proc/pressure", name).read_text().splitlines()
            }
        except OSError:
            pass
    for row in Path("/proc/net/dev").read_text().splitlines()[2:]:
        name, counters = row.split(":", 1)
        value["network"][name.strip()] = [int(x) for x in counters.split()]
    value["diskstats"] = [
        row.split() for row in Path("/proc/diskstats").read_text().splitlines()
    ]
    return value


def process_sample(pid, heavy=False):
    path = Path("/proc", str(pid))
    try:
        raw = (path / "stat").read_text().rsplit(")", 1)[1].split()
        # status has non-numeric entries; parse only the required numeric fields.
        fields = dict(
            row.split(":", 1)
            for row in (path / "status").read_text().splitlines()
            if ":" in row
        )
        value = {
            "pid": pid,
            "startTicks": int(raw[19]),
            "utime": int(raw[11]),
            "stime": int(raw[12]),
            "minorFaults": int(raw[7]),
            "majorFaults": int(raw[9]),
            "rssKiB": int(fields.get("VmRSS", "0 kB").split()[0]),
            "swapKiB": int(fields.get("VmSwap", "0 kB").split()[0]),
            "threads": int(fields["Threads"]),
            "fds": len(list((path / "fd").iterdir())),
            "mainThreadContextSwitches": {
                k: int(fields[k])
                for k in ("voluntary_ctxt_switches", "nonvoluntary_ctxt_switches")
                if k in fields
            },
        }
        if heavy:
            value["ioBytesAndCalls"] = numeric_file(path / "io")
            try:
                cgroup = next(
                    row.split(":", 2)[2]
                    for row in (path / "cgroup").read_text().splitlines()
                    if row.startswith("0::")
                )
                directory = Path("/sys/fs/cgroup") / cgroup.lstrip("/")
                value["cgroup"] = {
                    "path": cgroup,
                    **{
                        name: (directory / name).read_text().strip()
                        for name in (
                            "memory.current",
                            "memory.max",
                            "memory.high",
                            "memory.events",
                            "memory.pressure",
                            "io.pressure",
                            "cpu.stat",
                            "cpu.max",
                            "io.stat",
                        )
                        if (directory / name).exists()
                    },
                }
            except OSError:
                pass
            smaps = numeric_file(path / "smaps_rollup")
            if "Pss" in smaps:
                value["pssKiB"] = smaps["Pss"]
        return value
    except (OSError, ValueError, KeyError):
        return {"pid": pid, "gone": True}


def descendants(pid):
    found, remaining = set(), [pid]
    while remaining:
        parent = remaining.pop()
        try:
            for task in Path("/proc", str(parent), "task").iterdir():
                for child in (task / "children").read_text().split():
                    child = int(child)
                    if child not in found:
                        found.add(child)
                        remaining.append(child)
        except OSError:
            pass
    return found


def snapshot(pids, heavy=False):
    started = time.monotonic()
    processes = {key: process_sample(pid, heavy) for key, pid in pids.items()}
    host_tree = {str(pids["host"]): processes["host"]} if "host" in pids else {}
    if "host" in pids:
        host_tree.update(
            {str(pid): process_sample(pid, heavy) for pid in descendants(pids["host"])}
        )
    value = {
        "time": started,
        "wallTime": time.time(),
        "availableKiB": numeric_file("/proc/meminfo")["MemAvailable"],
        "processes": processes,
        "hostTree": host_tree,
    }
    if heavy:
        value["system"] = system_sample()
    value["samplingMs"] = 1000 * (time.monotonic() - started)
    return value


def attach(output):
    target = str(Path(output).resolve()).encode()
    controllers = []
    for path in Path("/proc").iterdir():
        if not path.name.isdigit() or int(path.name) == os.getpid():
            continue
        try:
            args = (path / "cmdline").read_bytes().split(b"\0")
            if any(x.endswith(b"/compare.py") for x in args) and target in args:
                controllers.append(int(path.name))
        except OSError:
            pass
    if len(controllers) != 1:
        print(
            json.dumps(
                {"attach": "no unique live controller", "count": len(controllers)}
            ),
            flush=True,
        )
        return
    controller = controllers[0]
    identity = process_sample(controller)["startTicks"]
    pids = {"providerController": controller, "supplementalMonitor": os.getpid()}
    for pid in descendants(controller):
        try:
            args = Path("/proc", str(pid), "cmdline").read_bytes().split(b"\0")
            if (b"host" in args and b"serve" in args) or any(
                x.endswith(b"/execution-candidate-main.js") for x in args
            ):
                pids["host"] = pid
            elif any(
                x.endswith((b"host_benchmark_client", b"ts-adapter.mjs")) for x in args
            ):
                pids["adapter"] = pid
        except OSError:
            pass
    with open(Path(output) / "supplemental-metrics.jsonl", "x", buffering=1) as stream:
        stream.write(
            json.dumps(
                {
                    "coverage": "attached mid-run; no historical backfill",
                    "pids": pids,
                    "started": time.time(),
                }
            )
            + "\n"
        )
        tick = 0
        while process_sample(controller).get("startTicks") == identity:
            stream.write(
                json.dumps(snapshot(pids, tick % 5 == 0), separators=(",", ":")) + "\n"
            )
            tick += 1
            time.sleep(0.2)
    print(json.dumps({"attach": "finished", "samples": tick}), flush=True)


if __name__ == "__main__":
    import sys

    attach(sys.argv[1])
