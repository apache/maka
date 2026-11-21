# -*- coding: utf-8 -*-
"""AppData 二级分布快扫（只读），结果追加进 inventory 报告。"""
import os, datetime
from pathlib import Path
import sys
sys.path.insert(0, r"E:\cc\guahub\sessions\tools")
from scan_phase1b import parallel_stats, HOME, REPORTS, fmt, dstr

def children_of(base):
    return [e.path for e in os.scandir(base)
            if e.is_dir(follow_symlinks=False) and not e.is_symlink() and not e.is_junction()]

def main():
    out = {}
    for sub in ("Local", "LocalLow", "Roaming"):
        base = HOME / "AppData" / sub
        if base.exists():
            m = parallel_stats(children_of(base), f"appdata-{sub}")
            out[sub] = sorted(((os.path.basename(p), *v) for p, v in m.items()), key=lambda r: -r[1])

    lines = ["", "### 4.3 AppData 二级分布（Top 25 每区）", ""]
    for sub, rows in out.items():
        lines.append(f"**AppData\\{sub}**")
        lines.append("")
        lines.append("| 目录 | 大小 | 文件数 | 时间范围 |")
        lines.append("|---|---|---|---|")
        for name, s, c, a, b in rows[:25]:
            tr = f"{dstr(a)} ~ {dstr(b)}" if c else "-"
            lines.append(f"| {name} | {fmt(s)} | {c} | {tr} |")
        lines.append("")

    rep = REPORTS / f"inventory_{datetime.date.today().isoformat()}.md"
    with open(rep, "a", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    for sub, rows in out.items():
        print(f"== AppData\\{sub} Top 15 ==")
        for name, s, c, a, b in rows[:15]:
            print(f"  {fmt(s):>10s} {c:>9d}  {name}")

if __name__ == "__main__":
    main()
