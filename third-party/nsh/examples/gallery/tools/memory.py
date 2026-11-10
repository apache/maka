#!/usr/bin/env python3
"""Measure one Linux release runner, excluding the CLI and build processes.

Example: python3 examples/gallery/tools/memory.py --bundle .nsh/out \
  --out target/agents/memory/hello.json -- target/release/nsh-linux-app
Requires an active desktop. Each renderer runs in a fresh process; the JSON
includes smaps totals and per-file residency at each sampling time. Units are
MiB (1024 ** 2 bytes). This measures the named process, not GPU allocations or
WebKit child processes. Use perf.py separately to measure animation costs.
"""

import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import time


def snapshot(pid):
    totals = {}
    files = {}
    name = "[anonymous]"
    for line in Path(f"/proc/{pid}/smaps").read_text().splitlines():
        if re.match(r"^[0-9a-f]+-[0-9a-f]+ ", line):
            parts = line.split(maxsplit=5)
            name = parts[5] if len(parts) == 6 else "[anonymous]"
        elif match := re.match(r"^(Rss|Pss|Private_Clean|Private_Dirty|Swap):\s+(\d+) kB$", line):
            key, value = match[1], int(match[2])
            totals[key] = totals.get(key, 0) + value
            group = files.setdefault(name, {})
            group[key] = group.get(key, 0) + value
    totals["USS"] = totals.get("Private_Clean", 0) + totals.get("Private_Dirty", 0)
    return {
        "mib": {key: round(value / 1024, 2) for key, value in totals.items()},
        "files_kib": dict(sorted(files.items(), key=lambda item: -item[1].get("Rss", 0))),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle", type=Path)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--renderers", default="default,ngl,vulkan,cairo")
    parser.add_argument("--seconds", default="3,10")
    parser.add_argument("--repeats", type=int, default=3)
    parser.add_argument("--size", help="On Hyprland, float and resize the runner to WIDTHxHEIGHT")
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command:
        parser.error("provide a runner command after --")
    seconds = sorted(set(float(value) for value in args.seconds.split(",")))
    if args.repeats < 1 or not seconds or seconds[0] <= 0:
        parser.error("repeats and sampling times must be positive")
    if args.size and not re.fullmatch(r"[1-9]\d*x[1-9]\d*", args.size):
        parser.error("size must be WIDTHxHEIGHT")
    args.out.parent.mkdir(parents=True, exist_ok=True)
    report = {"command": command, "bundle": str(args.bundle.resolve()) if args.bundle else None,
              "uname": list(os.uname()), "size": args.size,
              "environment": {key: os.environ.get(key) for key in
                              ("GDK_BACKEND", "GDK_DISABLE", "NSH_GALLERY_DEMO", "NSH_GALLERY_SECTION")},
              "samples": []}
    for renderer in args.renderers.split(","):
        for repeat in range(args.repeats):
            env = os.environ.copy()
            env.pop("GSK_RENDERER", None)
            if renderer != "default":
                env["GSK_RENDERER"] = renderer
            if args.bundle:
                env["NSH_APP_DIR"] = str(args.bundle.resolve())
            log = args.out.with_name(f"{args.out.stem}-{renderer}-{repeat}.log")
            with log.open("w") as output:
                process = subprocess.Popen(command, env=env, stdout=output, stderr=output)
                started = time.monotonic()
                try:
                    if args.size:
                        deadline = started + 10
                        while True:
                            clients = json.loads(subprocess.check_output(["hyprctl", "clients", "-j"]))
                            window = next((c for c in clients if c["pid"] == process.pid), None)
                            if window:
                                break
                            if process.poll() is not None or time.monotonic() > deadline:
                                raise RuntimeError(f"no runner window; see {log}")
                            time.sleep(0.1)
                        target = f"address:{window['address']}"
                        width, height = args.size.split("x")
                        actions = [f'hl.dsp.window.float({{action="on", window="{target}"}})',
                                   f'hl.dsp.window.resize({{window="{target}", x={width}, y={height}}})']
                        for action in actions:
                            result = subprocess.check_output(["hyprctl", "dispatch", action], text=True)
                            if result.strip() != "ok":
                                raise RuntimeError(result)
                        started = time.monotonic()
                    for second in seconds:
                        while time.monotonic() - started < second:
                            if process.poll() is not None:
                                raise RuntimeError(f"runner exited ({process.returncode}); see {log}")
                            time.sleep(min(0.1, max(0, second - (time.monotonic() - started))))
                        errors = [line for line in log.read_text().splitlines()
                                  if line.startswith(("ERROR js:", "ERROR nsh_platform_linux::surface:"))]
                        if errors:
                            raise RuntimeError(f"app failed to render; see {log}: {errors[0]}")
                        sample = {"renderer": renderer, "repeat": repeat, "seconds": second,
                                  **snapshot(process.pid)}
                        if args.size:
                            clients = json.loads(subprocess.check_output(["hyprctl", "clients", "-j"]))
                            sample["windows"] = [{k: c[k] for k in ("size", "floating", "class")} for c in clients if c["pid"] == process.pid]
                        report["samples"].append(sample)
                        args.out.write_text(json.dumps(report, indent=2) + "\n")
                        print(renderer, repeat, second, sample["mib"], flush=True)
                finally:
                    process.terminate()
                    try:
                        process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait()


if __name__ == "__main__":
    main()
