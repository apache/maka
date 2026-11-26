#!/usr/bin/env python3
"""End-to-end jank benchmark: startup to the first frame, and the frame gaps while a long list scrolls and
animations run, on this desktop's development host.

    python3 examples/bench/jank/jank.py                       # compare with the baseline, exit 1 over budget
    python3 examples/bench/jank/jank.py --runs 5 --write      # record this machine's baseline
    python3 examples/bench/jank/jank.py --stall 150           # check the gate: a 150 ms wait at launch fails it

Runs `nsh test jank.test.tsx --target <platform> --fps` (`--runs` times) and reads the test's marks (`@@jank`) and
the performance monitor's line of every second (`nsh::fps`). Measured:

- `startup`: `open()` of the TSX app to its window on screen with the first rows (median of the runs). Fails when
  it is slower than the baseline by more than `--startup-slack` ms (default 100): a fixed wait such as #3365's
  250 ms shows here, while the frame-cost benchmarks do not see it.
- `animation` / `scroll`: the main thread's time per drawn frame (`frame`: the worst second's p95 and the max)
  against 8.3 ms, one refresh at 120 Hz, which holds whatever this display's rate; and the gaps between drawn frames (`gap`) over every second of the scenario: p50 (median of
  the seconds' medians), p95 (the worst second's p95) and max, and `over`, the share of frames longer than one
  refresh. Fails when the p95 frame cost is over 8.3 ms, the p50 gap is longer than one refresh plus 1 ms (a frame missed on every refresh), or the max
  gap is longer than `--long-frame` ms (default 50: a hitch the user sees), on a host running at full priority.

The budget is the display's refresh: 8.3 ms at 120 Hz. Gaps are measured on the main thread, so a host at
background priority (macOS daemons: `taskpolicy`) reads long gaps from its timers alone; run it from a terminal.
Baselines are per platform in `baseline.json`; docs/dev/performance.md keeps them with the machine they came from.
"""

from __future__ import annotations

import argparse
import json
import re
import statistics
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent.parent
BASELINE = HERE / "baseline.json"
STALL = HERE / "stall.ts"
# One refresh at 120 Hz: the main thread's time per drawn frame stays within it whatever the display's rate.
FRAME_BUDGET_MS = 8.33

LINE = re.compile(r"fps (?P<fps>\d+)/(?P<hz>\d+) frame (?P<frame>[\d./]+) gap (?P<gap>[\d./]+) over (?P<over>\d+)% ")
MARK = re.compile(r"@@jank (?P<name>\S+)(?: (?P<value>\d+))?")


def stat(text: str) -> list[float]:
    return [float(v) for v in text.split("/")]


def run(nsh: str, target: str, seconds: int, verbose: bool) -> dict:
    command = [nsh, "-v", "test", str(HERE / "jank.test.tsx"), "--target", target, "--fps", "--foreground"]
    print("$", " ".join(command), file=sys.stderr)
    env = {**__import__("os").environ, "JANK_SECONDS": str(seconds)}
    proc = subprocess.Popen(command, cwd=HERE, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    scenario, skip, log = None, 0, []
    result: dict = {"seconds": {}}
    assert proc.stdout
    for raw in proc.stdout:
        log.append(raw)
        if verbose:
            sys.stderr.write(raw)
        if m := MARK.search(raw):
            if m["name"] == "startup":
                result["startup"] = int(m["value"])
                continue
            scenario = None if m["name"] == "-" else m["name"]
            # The second the mark falls in is partly the previous scenario's.
            skip = 1
            continue
        if scenario and (m := LINE.search(raw)):
            if skip:
                skip -= 1
                continue
            if int(m["fps"]) == 0:
                continue
            result["seconds"].setdefault(scenario, []).append(
                {"hz": int(m["hz"]), "frame": stat(m["frame"]), "gap": stat(m["gap"]), "over": int(m["over"])}
            )
    if proc.wait() != 0 or "startup" not in result:
        sys.stderr.write("".join(log[-40:]))
        sys.exit(f"nsh test failed ({proc.returncode})")
    return result


def summarize(runs: list[dict]) -> dict:
    out: dict = {"startup_ms": statistics.median(r["startup"] for r in runs), "startup_runs": [r["startup"] for r in runs]}
    for name in ("animation", "scroll"):
        seconds = [s for r in runs for s in r["seconds"].get(name, [])]
        if not seconds:
            continue
        hz = statistics.median(s["hz"] for s in seconds)
        out[name] = {
            "hz": hz,
            "budget_ms": round(1000 / hz, 2),
            "frame_p95_ms": round(max(s["frame"][2] for s in seconds), 2),
            "frame_max_ms": round(max(s["frame"][3] for s in seconds), 2),
            "gap_p50_ms": round(statistics.median(s["gap"][1] for s in seconds), 2),
            "gap_p95_ms": round(max(s["gap"][2] for s in seconds), 2),
            "gap_max_ms": round(max(s["gap"][3] for s in seconds), 2),
            "over_pct": max(s["over"] for s in seconds),
            "seconds": len(seconds),
        }
    return out


def check(now: dict, base: dict | None, args) -> list[str]:
    failures = []
    if base and now["startup_ms"] > base["startup_ms"] + args.startup_slack:
        failures.append(
            f"startup {now['startup_ms']:.0f} ms > baseline {base['startup_ms']:.0f} ms + {args.startup_slack} ms"
        )
    for name in ("animation", "scroll"):
        s = now.get(name)
        if not s:
            failures.append(f"{name}: no frames drawn")
            continue
        if s["frame_p95_ms"] > FRAME_BUDGET_MS:
            failures.append(f"{name}: p95 main-thread frame {s['frame_p95_ms']} ms > {FRAME_BUDGET_MS} ms")
        if s["gap_p50_ms"] > s["budget_ms"] + 1:
            failures.append(f"{name}: p50 gap {s['gap_p50_ms']} ms > one refresh ({s['budget_ms']} ms)")
        if s["gap_max_ms"] > args.long_frame:
            failures.append(f"{name}: max gap {s['gap_max_ms']} ms > {args.long_frame} ms")
    return failures


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    native = {"linux": "linux", "win32": "windows"}
    parser.add_argument("--nsh", default="nsh", help="the nsh CLI (default: on PATH; target/release/nsh for a checkout's)")
    parser.add_argument("--target", default=next((t for p, t in native.items() if sys.platform.startswith(p)), "macos"))
    parser.add_argument("--runs", type=int, default=3)
    parser.add_argument("--seconds", type=int, default=4, help="per scenario")
    parser.add_argument("--startup-slack", type=int, default=100, help="ms over the baseline's startup that fail")
    parser.add_argument("--long-frame", type=float, default=50.0, help="ms: a longer frame gap fails")
    parser.add_argument("--stall", type=int, default=0, help="ms the app blocks before it mounts (checks the gate)")
    parser.add_argument("--write", action="store_true", help="record the result as this platform's baseline")
    parser.add_argument("--out", help="also write the result as JSON here")
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args()

    original = STALL.read_text()
    if args.stall:
        STALL.write_text(re.sub(r"STALL_MS = \d+", f"STALL_MS = {args.stall}", original))
    try:
        runs = [run(args.nsh, args.target, args.seconds, args.verbose) for _ in range(args.runs)]
    finally:
        STALL.write_text(original)
    now = summarize(runs)
    print(json.dumps(now, indent=2))
    if args.out:
        Path(args.out).write_text(json.dumps(now, indent=2) + "\n")

    baselines = json.loads(BASELINE.read_text()) if BASELINE.exists() else {}
    if args.write:
        baselines[args.target] = now
        BASELINE.write_text(json.dumps(baselines, indent=2) + "\n")
        print(f"wrote {args.target}'s baseline to {BASELINE.relative_to(REPO)}", file=sys.stderr)
        return 0
    base = baselines.get(args.target)
    if not base:
        print(f"no {args.target} baseline in {BASELINE.relative_to(REPO)}: startup is not compared", file=sys.stderr)
    failures = check(now, base, args)
    for f in failures:
        print(f"FAIL {f}", file=sys.stderr)
    if not failures:
        print("OK: within budget", file=sys.stderr)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
