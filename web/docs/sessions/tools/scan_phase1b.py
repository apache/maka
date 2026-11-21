# -*- coding: utf-8 -*-
"""阶段1盘点 v3（只读）：会话源 / Magpie 收录对照 / ZCode 数据库结构 / C 盘大户。
v3 修复：所有驱动代码放进 main() + __main__ 保护（Windows spawn 子进程会重 import 本模块，
模块级驱动代码会在子进程里再开进程池导致池崩溃）；DB 结构结果缓存到 _tmp/db_info.json；
单个目录并行失败时回退父进程单线程重试。
"""
import os, json, sqlite3, shutil, re, datetime
from pathlib import Path
from concurrent.futures import ProcessPoolExecutor, as_completed

HOME = Path(r"C:\Users\802165")
OUT = Path(r"E:\cc\guahub\sessions")
REPORTS = OUT / "reports"
DBTMP = OUT / "_tmp" / "db"
PROG = OUT / "_tmp" / "scan_progress.log"
TODAY = datetime.date.today().isoformat()

def log(msg):
    line = f"{datetime.datetime.now():%H:%M:%S} {msg}"
    with open(PROG, "a", encoding="utf-8") as f:
        f.write(line + "\n")

def fmt(n):
    n = float(n)
    for u in ("B", "KB", "MB", "GB", "TB"):
        if n < 1024 or u == "TB":
            return f"{int(n)} B" if u == "B" else f"{n:.1f} {u}"
        n /= 1024

def dstr(ts):
    if not ts:
        return "-"
    try:
        return datetime.datetime.fromtimestamp(ts).strftime("%Y-%m-%d")
    except (OSError, OverflowError, ValueError):
        return "?"

SECRET = [
    (re.compile(r"sk-[A-Za-z0-9_\-]{10,}"), "[REDACTED]"),
    (re.compile(r"gh[pbou]_[A-Za-z0-9]{10,}"), "[REDACTED]"),
    (re.compile(r"AKIA[0-9A-Z]{12,}"), "[REDACTED]"),
    (re.compile(r"[Bb]earer\s+[A-Za-z0-9._\-]{10,}"), "[REDACTED]"),
    (re.compile(r"(?i)password\s*[=:]\s*\S+"), "[REDACTED]"),
    (re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----"), "[REDACTED]"),
    (re.compile(r"glm-[A-Za-z0-9._\-]{20,}"), "[REDACTED]"),
]
def redact(s):
    if not isinstance(s, str):
        s = str(s)
    for pat, rep in SECRET:
        s = pat.sub(rep, s)
    return s

def clip(s, n=150):
    s = redact(s).replace("\n", "\\n").replace("\r", "")
    return s[: n - 3] + "..." if len(s) > n else s

def tree_stats(path):
    """(递归大小, 文件数, 最老mtime, 最新mtime)；symlink/junction 一律跳过"""
    total = cnt = 0
    tmin = float("inf"); tmax = 0.0
    try:
        it = os.scandir(path)
    except OSError:
        return 0, 0, 0.0, 0.0
    with it:
        for e in it:
            try:
                if e.is_symlink() or e.is_junction():
                    continue
                if e.is_dir(follow_symlinks=False):
                    s, c, a, b = tree_stats(e.path)
                    total += s; cnt += c
                    if c:
                        tmin = min(tmin, a); tmax = max(tmax, b)
                elif e.is_file(follow_symlinks=False):
                    st = e.stat(follow_symlinks=False)
                    total += st.st_size; cnt += 1
                    tmin = min(tmin, st.st_mtime); tmax = max(tmax, st.st_mtime)
            except OSError:
                pass
    if cnt == 0:
        tmin = tmax = 0.0
    return total, cnt, tmin, tmax

def parallel_stats(paths, tag):
    log(f"{tag}: {len(paths)} dirs")
    out = {}
    with ProcessPoolExecutor(max_workers=8) as ex:
        futs = {ex.submit(tree_stats, p): p for p in paths}
        done = 0
        for fut in as_completed(futs):
            p = futs[fut]
            try:
                out[p] = fut.result()
            except Exception as e:
                log(f"ERR(并行) {p}: {e}，回退单线程")
                out[p] = tree_stats(p)
            done += 1
            if done % 10 == 0 or done == len(paths):
                log(f"{tag}: {done}/{len(paths)}")
    return out

def inspect_db(copy: Path):
    b = sqlite3.connect(str(copy))
    cur = b.cursor()
    tables = [r[0] for r in cur.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")]
    info = []
    for t in tables:
        try:
            rows = cur.execute(f'SELECT COUNT(*) FROM "{t}"').fetchone()[0]
        except sqlite3.Error:
            rows = -1
        cols = [[r[1], r[2]] for r in cur.execute(f'PRAGMA table_info("{t}")')]
        samples = []
        if rows > 0:
            try:
                for row in cur.execute(f'SELECT * FROM "{t}" LIMIT 2'):
                    samples.append({c[0]: clip(v) for c, v in zip(cols, row)})
            except sqlite3.Error:
                pass
        info.append([t, rows, cols, samples])
    b.close()
    return info

def load_tsv():
    ROOT_LABEL = [
        (".claude\\projects", "claude/projects"),
        (".codex\\archived_sessions", "codex/archived_sessions"),
        (".codex\\sessions", "codex/sessions"),
        (".factory\\sessions", "factory/sessions"),
        (".kimi-code\\sessions", "kimi/sessions"),
        (".cursor\\projects", "cursor/agent-transcripts"),
        (".zcode\\cli\\rollout", "zcode/rollout"),
    ]
    def label_of(path):
        for pref, lab in ROOT_LABEL:
            if pref in path:
                return lab
        return "other"
    stats_by_src, xref_count = {}, {}
    tsv = REPORTS / f"sessions_crossref_{TODAY}.tsv"
    with open(tsv, encoding="utf-8") as f:
        next(f)
        for line in f:
            tool, path, size, mdate, idx = line.rstrip("\n").split("\t")
            lab = label_of(path)
            s = stats_by_src.setdefault(lab, [0, 0, mdate, mdate])
            s[0] += int(size); s[1] += 1
            s[2] = min(s[2], mdate); s[3] = max(s[3], mdate)
            x = xref_count.setdefault(tool, [0, 0])
            x[0 if idx == "Y" else 1] += 1
    return stats_by_src, xref_count

def load_dbs():
    cache = DBTMP / "db_info.json"
    if cache.exists():
        return json.loads(cache.read_text(encoding="utf-8"))
    out = {}
    for name in ("zcode-cli-db", "zcode-tasks-index"):
        copy = DBTMP / f"{name}.sqlite"
        out[name] = inspect_db(copy) if copy.exists() else None
    cache.write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")
    return out

def main():
    stats_by_src, xref_count = load_tsv()
    log("tsv ok")
    db_info = load_dbs()
    log("db ok")

    du = shutil.disk_usage("C:\\")
    children = [e.path for e in os.scandir(HOME)
                if e.is_dir(follow_symlinks=False) and not e.is_symlink() and not e.is_junction()]
    top_map = parallel_stats(children, "top-level")
    top = sorted(((os.path.basename(p), *v) for p, v in top_map.items()), key=lambda r: -r[1])

    CANDS = [
        ("npm cache",            HOME / "AppData/Local/npm-cache"),
        ("npm (~/.npm)",         HOME / ".npm"),
        ("pnpm store",           HOME / "AppData/Local/pnpm/store"),
        ("pnpm root",            HOME / "AppData/Local/pnpm"),
        ("pnpm (~/.pnpm-store)", HOME / ".pnpm-store"),
        ("yarn cache",           HOME / "AppData/Local/Yarn/Cache"),
        ("bun install cache",    HOME / ".bun/install/cache"),
        ("uv cache",             HOME / "AppData/Local/uv"),
        ("pip cache",            HOME / "AppData/Local/pip"),
        ("gradle caches",        HOME / ".gradle/caches"),
        ("maven repo",           HOME / ".m2/repository"),
        ("NuGet packages",       HOME / ".nuget/packages"),
        ("NuGet cache",          HOME / "AppData/Local/NuGet"),
        ("Docker (vhdx 所在)",    HOME / "AppData/Local/Docker"),
        ("WSL (Packages)",       HOME / "AppData/Local/Packages"),
        ("WSL (Local/wsl)",      HOME / "AppData/Local/wsl"),
        ("Cursor roaming",       HOME / "AppData/Roaming/Cursor"),
        ("Cursor (.cursor)",     HOME / ".cursor"),
        ("VS Code roaming",      HOME / "AppData/Roaming/Code"),
        ("Windsurf",             HOME / "AppData/Roaming/Windsurf"),
        ("Trae",                 HOME / "AppData/Roaming/Trae"),
        ("JetBrains local",      HOME / "AppData/Local/JetBrains"),
        ("%TEMP%",               HOME / "AppData/Local/Temp"),
        (".claude 其它",          HOME / ".claude"),
        (".cache",               HOME / ".cache"),
        ("@zcodedesktop-updater", HOME / "AppData/Local/@zcodedesktop-updater"),
        ("magpie 配置",           HOME / ".config/magpie"),
        ("magpie 缓存",           HOME / ".cache/magpie"),
        ("zcode cli",            HOME / ".zcode/cli"),
        ("zcode v2",             HOME / ".zcode/v2"),
        ("Roaming/ZCode",        HOME / "AppData/Roaming/ZCode"),
    ]
    exist = [(lab, str(p)) for lab, p in CANDS if p.exists()]
    cand_map = parallel_stats([p for _, p in exist], "cands")
    cand_rows = [(lab, p, *cand_map.get(p, (0, 0, 0.0, 0.0))) for lab, p in exist]
    cand_rows += [(lab, str(p), 0, 0, 0.0, 0.0) for lab, p in CANDS if not p.exists()]

    vhdx = []
    for base in (HOME / "AppData/Local/Docker", HOME / "AppData/Local/wsl", HOME / "AppData/Local/Packages"):
        if base.exists():
            for dp, dn, fn in os.walk(base):
                for f in fn:
                    if f.lower().endswith((".vhdx", ".vhd")):
                        p = Path(dp) / f
                        try:
                            vhdx.append((str(p), p.stat().st_size))
                        except OSError:
                            pass

    TEMP = HOME / "AppData/Local/Temp"
    tchildren = [e.path for e in os.scandir(TEMP)
                 if e.is_dir(follow_symlinks=False) and not e.is_symlink() and not e.is_junction()]
    tfiles = [(e.path, e.stat().st_size, e.stat().st_mtime) for e in os.scandir(TEMP)
              if e.is_file(follow_symlinks=False)]
    tmap = parallel_stats(tchildren, "temp")
    groups = {}
    for p, (s, c, a, b) in tmap.items():
        name = os.path.basename(p)
        key = None
        for pfx in ("TestGatewayFixQuitsOnlyAMagpie", "magpie-test-home-", "magpie-gateway-test-",
                    "magpie-library-test-", "magpie-auth-", "magpie-started-", "magpie-b-", "magpie-",
                    "zcode-bash-", "zcode-"):
            if name.startswith(pfx):
                key = pfx + "*"; break
        g = groups.setdefault(key or name, [0, 0, 0.0])
        g[0] += s; g[1] += c; g[2] = max(g[2], b)
    for p, sz, mt in tfiles:
        g = groups.setdefault(os.path.basename(p), [0, 0, 0.0])
        g[0] += sz; g[1] += 1; g[2] = max(g[2], mt)

    # ---------- 写报告 ----------
    R = []
    R.append(f"# 盘点报告 inventory — {TODAY}\n")
    R.append(f"- C 盘：总 {fmt(du.total)}，可用 {fmt(du.free)}（执行前基线）")
    R.append(f"- 扫描方式：对 C 盘只读；NTFS junction 跳过；大户扫描 8 进程并行；DB 经只读连接 backup 到 E 盘副本（14:20）后读取")
    R.append(f"- 脱敏规则：sk- / gh?_ / AKIA / Bearer / password= / 私钥 / glm-长串 → `[REDACTED]`（短模型名如 glm-5.3 保留）\n")

    R.append("## 1. 会话源盘点\n")
    R.append("| 路径 | 工具 | 类别 | 大小 | 文件数 | 时间范围 | 风险级别 | 建议 | 是否需要退出程序 |")
    R.append("|---|---|---|---|---|---|---|---|---|")
    risk_map = {
        "claude/projects": ("C", "先归档(raw/md)再谈清理；清了会减少 Magpie 历史统计", "否"),
        "codex/sessions": ("C", "先归档再谈清理", "否"),
        "codex/archived_sessions": ("C", "先归档再谈清理", "否"),
        "factory/sessions": ("C", "先归档再谈清理", "否"),
        "kimi/sessions": ("C", "先归档再谈清理", "否"),
        "cursor/agent-transcripts": ("C", "先归档再谈清理", "否"),
        "zcode/rollout": ("B", "model-io-* 归档后保留最新，其余可清", "否"),
    }
    for lab in sorted(stats_by_src):
        s, c, d1, d2 = stats_by_src[lab]
        rk, adv, ex = risk_map.get(lab, ("C", "先归档再谈清理", "否"))
        R.append(f"| `C:\\Users\\802165\\{lab.replace('/', chr(92))}` | {lab.split('/')[0]} | 会话原始文件 | {fmt(s)} | {c} | {d1} ~ {d2} | {rk} | {adv} | {ex} |")
    R.append("")
    R.append("### 1.1 Magpie sessions.json 收录对照\n")
    R.append(f"- 逐会话对照见 `sessions_crossref_{TODAY}.tsv`（indexed_by_magpie=Y/N）")
    for tool in sorted(xref_count):
        m, u = xref_count[tool]
        R.append(f"- {tool}: 已收录 {m} / 未收录 {u}")
    R.append("")

    R.append("## 2. ZCode 数据库结构（副本读取）\n")
    srcmap = {"zcode-cli-db": HOME / ".zcode/cli/db/db.sqlite", "zcode-tasks-index": HOME / ".zcode/v2/tasks-index.sqlite"}
    for name, info in db_info.items():
        if info is None:
            R.append(f"### {name}\n- 副本缺失\n")
            continue
        R.append(f"### {name}（源 {fmt(srcmap[name].stat().st_size)}，副本 `{DBTMP / (name + '.sqlite')}`）\n")
        R.append("| 表 | 行数 | 字段 |")
        R.append("|---|---|---|")
        for t, rows, cols, _ in info:
            cs = ", ".join(f"{c}({ty})" for c, ty in cols)
            R.append(f"| {t} | {rows} | {cs} |")
        R.append("")
        for t, rows, cols, samples in info:
            if samples:
                R.append(f"**{t}** 脱敏样本（2 条，字段值截断 150 字符）：")
                R.append("```json")
                for s in samples:
                    R.append(json.dumps(s, ensure_ascii=False))
                R.append("```\n")

    R.append("## 3. C:\\Users\\802165 目录体积 Top 40\n")
    R.append("| 目录 | 大小 | 文件数 | 时间范围 |")
    R.append("|---|---|---|---|")
    for name, s, c, a, b in top[:40]:
        tr = f"{dstr(a)} ~ {dstr(b)}" if c else "-"
        R.append(f"| {name} | {fmt(s)} | {c} | {tr} |")
    R.append("")

    R.append("## 4. 缓存与已知大户明细\n")
    R.append("| 项 | 路径 | 大小 | 文件数 | 时间范围 |")
    R.append("|---|---|---|---|---|")
    for label, p, s, c, a, b in cand_rows:
        tr = f"{dstr(a)} ~ {dstr(b)}" if c else "-"
        R.append(f"| {label} | `{p}` | {fmt(s)} | {c} | {tr} |")
    R.append("")
    R.append("### 4.1 vhdx 虚拟盘（只报告，不处理）\n")
    for p, s in sorted(vhdx, key=lambda r: -r[1]):
        R.append(f"- `{p}` — {fmt(s)}")
    if not vhdx:
        R.append("- 未找到 vhdx/vhd")
    R.append("")
    R.append("### 4.2 %TEMP% 按前缀分组 Top 25\n")
    R.append("| 分组 | 大小 | 文件数 | 最新 mtime |")
    R.append("|---|---|---|---|")
    for key, (s, c, mt) in sorted(groups.items(), key=lambda kv: -kv[1][0])[:25]:
        R.append(f"| {key} | {fmt(s)} | {c} | {dstr(mt)} |")
    R.append("")

    rep = REPORTS / f"inventory_{TODAY}.md"
    rep.write_text("\n".join(R), encoding="utf-8")
    log("report written")

    print("== 会话源 ==")
    for lab in sorted(stats_by_src):
        s, c, d1, d2 = stats_by_src[lab]
        print(f"  {lab:28s} {c:6d} files {fmt(s):>10s}  {d1}~{d2}")
    print("== Magpie 对照 ==")
    for tool, (m, u) in sorted(xref_count.items()):
        print(f"  {tool:8s} 收录 {m} / 未收录 {u}")
    print(f"== C 盘可用 {fmt(du.free)} / 总 {fmt(du.total)} ==")
    print("== 用户目录 Top 40 ==")
    for name, s, c, a, b in top[:40]:
        print(f"  {fmt(s):>10s} {c:>9d}  {name}")
    print("== 候选缓存明细 ==")
    for label, p, s, c, a, b in cand_rows:
        print(f"  {label:24s} {fmt(s):>10s} {c:>9d}")
    print("== vhdx ==")
    for p, s in sorted(vhdx, key=lambda r: -r[1]):
        print(f"  {fmt(s):>10s}  {p}")
    print("== Temp 分组 Top 25 ==")
    for key, (s, c, mt) in sorted(groups.items(), key=lambda kv: -kv[1][0])[:25]:
        print(f"  {fmt(s):>10s} {c:>9d}  {key}")
    print(f"\n报告: {rep}")

if __name__ == "__main__":
    main()
