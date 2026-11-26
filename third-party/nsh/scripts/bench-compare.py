#!/usr/bin/env python3
"""Run the nsh-engine micro benchmarks and compare two builds.

    bench-compare.py run BASE_BIN HEAD_BIN [--rounds N] [--json OUT]
    bench-compare.py table RESULT.json [--threshold PCT]

`run` alternates the two test binaries for N rounds so machine drift hits
both sides equally, and keeps the fastest value each metric reached.
`table` prints a Markdown table and exits 1 when a metric regressed by more
than the threshold.
"""
import argparse, json, re, subprocess, sys

BENCHES = ["bench_calls", "bench_components", "bench_handles"]
UNITS = {"ns": 1.0, "µs": 1e3, "us": 1e3, "ms": 1e6, "s": 1e9}
DUR = re.compile(r"(\d+(?:\.\d+)?)(ns|µs|us|ms|s)\b")


def parse(bench, text):
    out, section = {}, ""
    for raw in text.splitlines():
        # --nocapture prints the first line right after "test name ... ".
        raw = re.sub(r"^test \S+ \.\.\. ", "", raw)
        line = raw.rstrip()
        if not line or line in ("ok", "FAILED") or line.startswith("running ") or "test result" in line:
            continue
        if not raw.startswith(" ") and line.endswith(".tsx"):
            section = line + " / "
            continue
        pos, prefix = 0, None
        for m in DUR.finditer(line):
            ctx = line[pos:m.start()].strip(" ,(")
            pos = m.end()
            if ctx == "/":
                continue  # second value of a "min / median" pair
            head, _, rest = ctx.partition(": ")
            if prefix is None:
                prefix = head.strip()
                words = rest.split()
            else:
                words = ctx.split()
            name = f"{prefix} · {words[-1]}" if words else prefix
            out[f"{bench} / {section}{name.rstrip(':')}"] = float(m.group(1)) * UNITS[m.group(2)]
    return out


def run_once(binary, bench):
    p = subprocess.run([binary, bench, "--ignored", "--nocapture", "--test-threads=1"],
                       capture_output=True, text=True, check=True)
    return parse(bench, p.stdout + p.stderr)


def cmd_run(a):
    res = {"base": {}, "head": {}}
    for _ in range(a.rounds):
        for side, binary in (("base", a.base), ("head", a.head)):
            for bench in BENCHES:
                for k, v in run_once(binary, bench).items():
                    res[side][k] = min(v, res[side].get(k, v))
    json.dump(res, open(a.json, "w") if a.json else sys.stdout, indent=1, ensure_ascii=False)


def fmt(ns):
    for unit, f in (("ms", 1e6), ("µs", 1e3)):
        if ns >= f:
            return f"{ns / f:.2f}{unit}"
    return f"{ns:.1f}ns"


def cmd_table(a):
    res = json.load(open(a.result))
    base, head = res["base"], res["head"]
    worse, rows = [], []
    for k in sorted(set(base) | set(head)):
        if k not in base or k not in head:
            rows.append(f"| {k} | {fmt(base[k]) if k in base else '–'} | {fmt(head[k]) if k in head else '–'} | new/removed | |")
            continue
        d = (head[k] - base[k]) / base[k] * 100
        # Few-nanosecond metrics move by whole nanoseconds; ignore sub-2ns changes.
        bad = d > a.threshold and head[k] - base[k] > 2
        mark = "🔴" if bad else ("🟢" if d < -a.threshold else "")
        if bad:
            worse.append(k)
        rows.append(f"| {k} | {fmt(base[k])} | {fmt(head[k])} | {d:+.1f}% | {mark} |")
    print(f"### Engine benchmarks (threshold {a.threshold:.0f}%)\n")
    print(f"{len(worse)} regression(s) over {a.threshold:.0f}%." if worse else f"No regression over {a.threshold:.0f}%.")
    print("\n<details><summary>All metrics (fastest of each round, lower is better)</summary>\n")
    print("| Metric | main | PR | Change | |\n|---|---:|---:|---:|---|")
    print("\n".join(rows))
    print("\n</details>")
    return 1 if worse else 0


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run"); r.add_argument("base"); r.add_argument("head")
    r.add_argument("--rounds", type=int, default=5); r.add_argument("--json")
    t = sub.add_parser("table"); t.add_argument("result")
    t.add_argument("--threshold", type=float, default=10.0)
    a = ap.parse_args()
    sys.exit(cmd_run(a) if a.cmd == "run" else cmd_table(a))


if __name__ == "__main__":
    main()
