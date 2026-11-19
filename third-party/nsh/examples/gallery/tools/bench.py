#!/usr/bin/env python3
"""Startup, process-tree CPU / memory and size samples in one versioned format.

The companion of `perf.py` (frame rate per gallery page through `nsh test`) and
`memory.py` (one Linux runner's smaps by file): this measures fresh processes
from outside, so each platform's numbers come out comparable and every failed or
timed-out sample is kept rather than dropped.

    # Ten fresh launches; the window milestone is when the compositor maps a
    # window of the process tree (Hyprland), not a test handshake.
    python3 examples/gallery/tools/bench.py startup --runs 10 --out out/start -- <runner>
    # Five rounds of 30 s idle: CPU (100% = one core) and memory of the tree.
    python3 examples/gallery/tools/bench.py run --rounds 5 --seconds 30 --out out/idle -- <runner>
    # Sizes of the files and directories given (directories are summed).
    python3 examples/gallery/tools/bench.py size --out out/size main=target/release/nsh-linux-host ...

Each command writes `<out>.json` (schema `nsh-bench/1`: conditions, every raw
sample with its status, and the summary) and `<out>.csv` (one row per sample).
Milestones that cannot be observed are `null`, never estimated: `window_ms`
(window mapped) is seen from outside; `first_frame_ms` is the app's own
`nsh::startup first_frame <ms>` log line (first presented frame, from the
process start, 10 ms resolution; Linux GTK and GPUI runtimes only, enabled
here through `RUST_LOG`); there is no interactive signal yet. Memory on Linux is
the tree's sum of `smaps_rollup` RSS / PSS / USS (Private_Clean+Private_Dirty)
in MiB; GPU memory is not included. Other systems: N/A in this tool.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import platform
import re
import resource
import signal
import statistics
import subprocess
import sys
import time
from pathlib import Path

SCHEMA = "nsh-bench/1"
TICKS = os.sysconf("SC_CLK_TCK") if hasattr(os, "sysconf") else 100


def children(pid: int) -> list[int]:
    """The process and all its descendants (Linux /proc)."""
    seen, todo = [], [pid]
    while todo:
        p = todo.pop()
        seen.append(p)
        try:
            for task in Path(f"/proc/{p}/task").iterdir():
                todo += [int(c) for c in (task / "children").read_text().split()]
        except OSError:
            pass
    return seen


def cpu_ticks(pids: list[int]) -> int:
    total = 0
    for p in pids:
        try:
            fields = Path(f"/proc/{p}/stat").read_text().rsplit(")", 1)[1].split()
            total += int(fields[11]) + int(fields[12])  # utime, stime
        except (OSError, IndexError, ValueError):
            pass
    return total


def cpu_percent(ticks: int, seconds: float, tick_rate: int = TICKS) -> float:
    """CPU time over wall time, 100 = one core fully busy."""
    return 100.0 * ticks / tick_rate / seconds if seconds > 0 else 0.0


def memory(pids: list[int]) -> dict[str, float]:
    keys = ("Rss", "Pss", "Private_Clean", "Private_Dirty")
    total = dict.fromkeys(keys, 0)
    for p in pids:
        try:
            for line in Path(f"/proc/{p}/smaps_rollup").read_text().splitlines():
                name, _, rest = line.partition(":")
                if name in total:
                    total[name] += int(rest.split()[0])
        except (OSError, ValueError, IndexError):
            pass
    return {"rss_mib": round(total["Rss"] / 1024, 2), "pss_mib": round(total["Pss"] / 1024, 2),
            "uss_mib": round((total["Private_Clean"] + total["Private_Dirty"]) / 1024, 2)}


def window_of(pids: list[int]) -> dict | None:
    """A mapped window of one of the processes, on Hyprland; None elsewhere or before it maps."""
    try:
        clients = json.loads(subprocess.run(["hyprctl", "clients", "-j"], capture_output=True, text=True,
                                            timeout=2).stdout or "[]")
    except (OSError, subprocess.TimeoutExpired, ValueError):
        return None
    return next((c for c in clients if c.get("pid") in pids and c.get("mapped", True)), None)


STARTUP_LOG = "nsh::startup=info"
FIRST_FRAME = re.compile(r"nsh::startup\S*:? first_frame (\d+(?:\.\d+)?)")


def startup_env(env: dict | None) -> dict:
    """`env` (else ours) with the runtime's startup milestones logged."""
    env = dict(os.environ if env is None else env)
    current = env.get("RUST_LOG")
    env["RUST_LOG"] = f"{current},{STARTUP_LOG}" if current else f"warn,js=info,{STARTUP_LOG}"
    return env


def first_frame(log: Path) -> float | None:
    """The `first_frame` milestone the app logged, in ms from its start."""
    try:
        m = FIRST_FRAME.search(log.read_text(errors="replace"))
    except OSError:
        return None
    return float(m.group(1)) if m else None


def launch(command: list[str], log: Path, env: dict | None = None) -> subprocess.Popen:
    env = startup_env(env)
    log.parent.mkdir(parents=True, exist_ok=True)
    out = log.open("w")
    # Its own process group, so cleanup reaches every child.
    return subprocess.Popen(command, stdout=out, stderr=subprocess.STDOUT, env=env, start_new_session=True)


def stop(proc: subprocess.Popen, grace: float = 3.0) -> list[int]:
    """Terminate the process group; returns the pids still alive after SIGKILL (should be none)."""
    pids = children(proc.pid)
    for sig in (signal.SIGTERM, signal.SIGKILL):
        try:
            os.killpg(proc.pid, sig)
        except ProcessLookupError:
            pass
        for p in pids:  # descendants that left the group
            try:
                os.kill(p, sig)
            except ProcessLookupError:
                pass
        try:
            proc.wait(timeout=grace)
        except subprocess.TimeoutExpired:
            continue
        if sig == signal.SIGTERM:
            time.sleep(0.05)
        if not alive(pids):
            break
    if proc.stdout:
        proc.stdout.close()
    time.sleep(0.05)
    return alive(pids)


def alive(pids: list[int]) -> list[int]:
    left = []
    for p in pids:
        try:
            state = Path(f"/proc/{p}/stat").read_text().rsplit(")", 1)[1].split()[0]
        except OSError:
            continue
        if state != "Z":
            left.append(p)
    return left


def wait_window(proc: subprocess.Popen, started: float, timeout: float, need_window: bool) -> tuple[str, float | None]:
    while time.monotonic() - started < timeout:
        if proc.poll() is not None:
            return ("exited" if need_window else "ok"), None
        if need_window and window_of(children(proc.pid)):
            return "ok", (time.monotonic() - started) * 1000
        if not need_window:
            return "ok", None
        time.sleep(0.01)
    return "timeout", None


def stats(values: list[float]) -> dict | None:
    if not values:
        return None
    s = sorted(values)
    p95 = s[min(len(s) - 1, round(0.95 * (len(s) - 1)))]
    return {"n": len(s), "median": round(statistics.median(s), 2), "p95": round(p95, 2),
            "min": round(s[0], 2), "max": round(s[-1], 2),
            "stdev": round(statistics.stdev(s), 2) if len(s) > 1 else 0.0}


def summarize(samples: list[dict], fields: list[str]) -> dict:
    ok = [s for s in samples if s["status"] == "ok"]
    out = {"samples": len(samples), "ok": len(ok),
           "failed": {k: sum(1 for s in samples if s["status"] == k) for k in
                      sorted({s["status"] for s in samples} - {"ok"})}}
    for f in fields:
        out[f] = stats([s[f] for s in ok if s.get(f) is not None])
    return out


def conditions(command: list[str] | None, args: argparse.Namespace) -> dict:
    def sh(*c: str) -> str | None:
        try:
            return subprocess.run(c, capture_output=True, text=True, timeout=5).stdout.strip() or None
        except (OSError, subprocess.TimeoutExpired):
            return None
    return {"command": command, "cwd": os.getcwd(), "git": sh("git", "rev-parse", "HEAD"),
            "dirty": bool(sh("git", "status", "--porcelain", "--untracked-files=no")),
            "rustc": sh("rustc", "--version"), "host": platform.uname()._asdict(),
            "cpus": os.cpu_count(), "load": os.getloadavg() if hasattr(os, "getloadavg") else None,
            "session": os.environ.get("XDG_SESSION_TYPE"), "note": getattr(args, "note", None),
            "memory_definition": "Linux: sum over the process tree of smaps_rollup Rss/Pss, USS=Private_Clean+Private_Dirty, MiB; excludes GPU",
            "cpu_definition": "process tree utime+stime / wall time, 100 = one core"}


def write(out: Path, report: dict) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    out.with_suffix(".json").write_text(json.dumps(report, indent=2) + "\n")
    rows = report["samples"]
    keys = list(dict.fromkeys(k for r in rows for k in r if not isinstance(r[k], (dict, list))))
    with out.with_suffix(".csv").open("w", newline="") as f:
        w = csv.DictWriter(f, keys)
        w.writeheader()
        for r in rows:
            w.writerow({k: r.get(k) for k in keys})


def overhead() -> float:
    u = resource.getrusage(resource.RUSAGE_SELF)
    return u.ru_utime + u.ru_stime


def cmd_startup(args, command) -> dict:
    samples = []
    for i in range(args.runs):
        log = args.out.with_name(f"{args.out.name}-start-{i}.log")
        started = time.monotonic()
        proc = launch(command, log)
        status, ms = wait_window(proc, started, args.timeout, not args.no_window)
        if status == "ok" and args.settle:
            time.sleep(args.settle)
        mem = memory(children(proc.pid)) if status == "ok" else {}
        left = stop(proc)
        samples.append({"run": i, "status": status, "window_ms": round(ms, 1) if ms else None,
                        "first_frame_ms": first_frame(log) if status == "ok" else None, "interactive_ms": None, **mem,
                        "exit_code": proc.returncode, "leaked": len(left), "log": str(log)})
        print(json.dumps(samples[-1]), flush=True)
        time.sleep(args.gap)
    return {"kind": "startup", "samples": samples,
            "summary": summarize(samples, ["window_ms", "first_frame_ms", "rss_mib", "pss_mib", "uss_mib"])}


def cmd_run(args, command) -> dict:
    samples = []
    for i in range(args.rounds):
        log = args.out.with_name(f"{args.out.name}-run-{i}.log")
        started = time.monotonic()
        proc = launch(command, log)
        status, _ = wait_window(proc, started, args.timeout, not args.no_window)
        sample = {"round": i, "status": status}
        try:
            if status == "ok":
                time.sleep(args.warmup)
                op = subprocess.Popen(args.action, shell=True) if args.action else None
                before_self = overhead()
                t0, c0 = time.monotonic(), cpu_ticks(children(proc.pid))
                peak = {"rss_mib": 0.0, "pss_mib": 0.0, "uss_mib": 0.0}
                while time.monotonic() - t0 < args.seconds:
                    if proc.poll() is not None:
                        sample["status"] = "exited"
                        break
                    m = memory(children(proc.pid))
                    peak = {k: max(peak[k], m[k]) for k in peak}
                    time.sleep(args.interval)
                wall = time.monotonic() - t0
                ticks = cpu_ticks(children(proc.pid)) - c0
                if op:
                    op.terminate()
                    op.wait()
                sample |= {"seconds": round(wall, 2), "cpu_pct": round(cpu_percent(ticks, wall), 2),
                           **{f"{k}_peak": v for k, v in peak.items()}, **memory(children(proc.pid)),
                           "sampler_cpu_pct": round(100 * (overhead() - before_self) / wall, 2)}
        finally:
            sample |= {"exit_code": proc.poll(), "leaked": len(stop(proc)), "log": str(log)}
        samples.append(sample)
        print(json.dumps(sample), flush=True)
        time.sleep(args.gap)
    return {"kind": "run", "action": args.action, "samples": samples,
            "summary": summarize(samples, ["cpu_pct", "rss_mib", "pss_mib", "uss_mib", "rss_mib_peak",
                                           "sampler_cpu_pct"])}


def size_of(path: Path) -> int:
    if path.is_dir():
        return sum(p.stat().st_size for p in path.rglob("*") if p.is_file() and not p.is_symlink())
    return path.stat().st_size


def cmd_size(args, items) -> dict:
    samples = []
    for item in items:
        name, _, path = item.partition("=")
        p = Path(path or name)
        try:
            samples.append({"name": name, "path": str(p), "status": "ok", "bytes": size_of(p)})
        except OSError as e:
            samples.append({"name": name, "path": str(p), "status": "missing", "bytes": None, "error": str(e)})
    return {"kind": "size", "samples": samples}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="kind", required=True)
    for name in ("startup", "run", "size"):
        p = sub.add_parser(name)
        p.add_argument("--out", type=Path, required=True, help="path without extension")
        p.add_argument("--note", help="free-form conditions (window size, features, data)")
        if name != "size":
            p.add_argument("--timeout", type=float, default=20)
            p.add_argument("--gap", type=float, default=1.0, help="seconds between processes")
            p.add_argument("--no-window", action="store_true", help="do not wait for a window (headless/CLI)")
        p.add_argument("items", nargs=argparse.REMAINDER)
    sub.choices["startup"].add_argument("--runs", type=int, default=10)
    sub.choices["startup"].add_argument("--settle", type=float, default=2.0, help="seconds after the window before memory")
    r = sub.choices["run"]
    r.add_argument("--rounds", type=int, default=5)
    r.add_argument("--seconds", type=float, default=30)
    r.add_argument("--warmup", type=float, default=3)
    r.add_argument("--interval", type=float, default=1.0)
    r.add_argument("--action", help="shell command driving an operation during the window (e.g. scrolling)")
    args = parser.parse_args(argv)
    items = args.items[1:] if args.items[:1] == ["--"] else args.items
    if not items:
        parser.error("provide a command after -- (or paths for size)")
    t0 = overhead()
    body = {"startup": cmd_startup, "run": cmd_run, "size": cmd_size}[args.kind](args, items)
    report = {"schema": SCHEMA, "created": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
              "conditions": conditions(None if args.kind == "size" else items, args), **body,
              "sampler_cpu_seconds": round(overhead() - t0, 3)}
    write(args.out, report)
    print(json.dumps(report.get("summary", report["samples"]), indent=2))
    return 0 if all(s["status"] == "ok" for s in body["samples"]) else 1


if __name__ == "__main__":
    sys.exit(main())
