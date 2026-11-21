# -*- coding: utf-8 -*-
"""阶段1盘点（只读）：会话源 / Magpie 收录对照 / ZCode 数据库结构 / C 盘大户。
对 C 盘只读；唯一写入是 E:\\cc\\guahub\\sessions 下的 reports/、_tmp/（DB 只读副本）。
"""
import os, json, sqlite3, shutil, re, datetime
from pathlib import Path

HOME = Path(r"C:\Users\802165")
OUT = Path(r"E:\cc\guahub\sessions")
REPORTS = OUT / "reports"
DBTMP = OUT / "_tmp" / "db"
TODAY = datetime.date.today().isoformat()

# ---------- 工具函数 ----------
def fmt(n):
    n = float(n)
    for u in ("B", "KB", "MB", "GB", "TB"):
        if n < 1024 or u == "TB":
            return f"{int(n)} B" if u == "B" else f"{n:.1f} {u}"
        n /= 1024

def dstr(ts):
    return datetime.datetime.fromtimestamp(ts).strftime("%Y-%m-%d") if ts else "-"

SECRET = [
    (re.compile(r"sk-[A-Za-z0-9_\-]{10,}"), "[REDACTED]"),
    (re.compile(r"gh[pbou]_[A-Za-z0-9]{10,}"), "[REDACTED]"),
    (re.compile(r"AKIA[0-9A-Z]{12,}"), "[REDACTED]"),
    (re.compile(r"[Bb]earer\s+[A-Za-z0-9._\-]{10,}"), "[REDACTED]"),
    (re.compile(r"(?i)password\s*[=:]\s*\S+"), "[REDACTED]"),
    (re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----"), "[REDACTED]"),
    # glm- 长串按密钥脱敏；短的（如模型名 glm-5.3）保留，避免毁掉归档可读性
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
    """返回 (递归大小, 文件数, 最老mtime, 最新mtime)"""
    total = cnt = 0
    tmin = float("inf"); tmax = 0.0
    try:
        it = os.scandir(path)
    except OSError:
        return 0, 0, 0.0, 0.0
    with it:
        for e in it:
            try:
                if e.is_symlink():
                    continue
                if e.is_dir(follow_symlinks=False):
                    s, c, a, b = tree_stats(e.path)
                    total += s; cnt += c
                    tmin = min(tmin, a) if c else tmin
                    tmax = max(tmax, b)
                elif e.is_file(follow_symlinks=False):
                    st = e.stat(follow_symlinks=False)
                    total += st.st_size; cnt += 1
                    tmin = min(tmin, st.st_mtime); tmax = max(tmax, st.st_mtime)
            except OSError:
                pass
    if cnt == 0:
        tmin = tmax = 0.0
    return total, cnt, tmin, tmax

# ---------- 1. 会话源枚举 ----------
SOURCES = [  # (工具, 根, 过滤器)
    ("claude",  HOME / ".claude" / "projects",            lambda p, n, rel: n.endswith(".jsonl")),
    ("codex",   HOME / ".codex" / "sessions",             lambda p, n, rel: True),
    ("codex",   HOME / ".codex" / "archived_sessions",    lambda p, n, rel: True),
    ("factory", HOME / ".factory" / "sessions",           lambda p, n, rel: True),
    ("kimi",    HOME / ".kimi-code" / "sessions",         lambda p, n, rel: True),
    ("cursor",  HOME / ".cursor" / "projects",            lambda p, n, rel: "agent-transcripts" in rel.parts),
    ("zcode",   HOME / ".zcode" / "cli" / "rollout",      lambda p, n, rel: n.startswith("model-io-") and n.endswith(".jsonl")),
]
files_by_tool = {}   # tool -> [(path, size, mtime)]
stats_by_src = {}    # (tool, root) -> (size, cnt, tmin, tmax)

for tool, root, keep in SOURCES:
    recs = files_by_tool.setdefault(tool, [])
    total = cnt = 0; tmin = float("inf"); tmax = 0.0
    if root.exists():
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [d for d in dirnames if not d.startswith(".")] or dirnames  # 保留
            for fn in filenames:
                rel = Path(dirpath).relative_to(root)
                if not keep(Path(dirpath), fn, rel):
                    continue
                p = Path(dirpath) / fn
                try:
                    st = p.stat()
                except OSError:
                    continue
                recs.append((str(p), st.st_size, st.st_mtime))
                total += st.st_size; cnt += 1
                tmin = min(tmin, st.st_mtime); tmax = max(tmax, st.st_mtime)
    if cnt == 0:
        tmin = tmax = 0.0
    stats_by_src[(tool, root)] = (total, cnt, tmin, tmax)

# ---------- 2. Magpie 收录对照 ----------
mag = HOME / ".cache" / "magpie" / "sessions.json"
idx_keys = set(); idx_stale = 0; idx_total = 0
try:
    with open(mag, encoding="utf-8") as f:
        idx = json.load(f)
    idx_total = len(idx.get("files", {}))
    for k in idx.get("files", {}):
        kp = str(k)
        idx_keys.add(kp.casefold())
        if not Path(kp).exists():
            idx_stale += 1
except Exception as e:
    print("WARN sessions.json:", e)

xref_rows = []
xref_count = {}  # tool -> (matched, unmatched)
for tool, recs in files_by_tool.items():
    m = u = 0
    for path, size, mt in recs:
        hit = path.casefold() in idx_keys
        xref_rows.append((tool, path, size, dstr(mt), "Y" if hit else "N"))
        m += hit; u += (not hit)
    xref_count[tool] = (m, u)

tsv = REPORTS / f"sessions_crossref_{TODAY}.tsv"
with open(tsv, "w", encoding="utf-8") as f:
    f.write("tool\tpath\tsize\tmtime\tindexed_by_magpie\n")
    for r in sorted(xref_rows):
        f.write("\t".join(map(str, r)) + "\n")

# ---------- 3. ZCode 数据库：只读备份副本 + 结构 ----------
DBSRCS = [
    ("zcode-cli-db", HOME / ".zcode" / "cli" / "db" / "db.sqlite"),
    ("zcode-tasks-index", HOME / ".zcode" / "v2" / "tasks-index.sqlite"),
]
db_info = {}  # name -> dict(tables=[(t, rows, cols, samples)])
for name, src in DBSRCS:
    dst = DBTMP / f"{name}.sqlite"
    if not src.exists():
        db_info[name] = None
        continue
    con = sqlite3.connect(src.as_uri() + "?mode=ro", uri=True)
    b = sqlite3.connect(str(dst))
    con.backup(b)
    con.close()
    cur = b.cursor()
    tables = [r[0] for r in cur.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")]
    info = []
    for t in tables:
        try:
            rows = cur.execute(f'SELECT COUNT(*) FROM "{t}"').fetchone()[0]
        except sqlite3.Error:
            rows = -1
        cols = [(r[1], r[2]) for r in cur.execute(f'PRAGMA table_info("{t}")')]
        samples = []
        if rows > 0:
            try:
                for row in cur.execute(f'SELECT * FROM "{t}" LIMIT 2'):
                    samples.append({c[0]: clip(v) for c, v in zip(cols, row)})
            except sqlite3.Error:
                pass
        info.append((t, rows, cols, samples))
    b.close()
    db_info[name] = {"size": src.stat().st_size, "copy": str(dst), "tables": info}

# ---------- 4. C 盘大户 ----------
du = shutil.disk_usage("C:\\")
top = []
for e in os.scandir(HOME):
    try:
        if e.is_symlink():
            continue
        if e.is_dir(follow_symlinks=False):
            top.append((e.name, *tree_stats(e.path)))
    except OSError:
        pass
top.sort(key=lambda r: -r[1])

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
    ("WSL (Lxss/Packages)",  HOME / "AppData/Local/Packages"),
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
]
cand_rows = []
for label, p in CANDS:
    if p.exists():
        cand_rows.append((label, str(p), *tree_stats(p)))
    else:
        cand_rows.append((label, str(p), 0, 0, 0.0, 0.0))

# vhdx 只报告
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

# Temp 分组
TEMP = HOME / "AppData/Local/Temp"
groups = {}
for e in os.scandir(TEMP):
    try:
        if e.is_file(follow_symlinks=False):
            st = e.stat(); key = e.name
            groups.setdefault(key, [0, 0, 0.0]); g = groups[key]
            g[0] += st.st_size; g[1] += 1; g[2] = max(g[2], st.st_mtime)
        elif e.is_dir(follow_symlinks=False):
            s, c, a, b = tree_stats(e.path)
            name = e.name
            key = None
            for pfx in ("TestGatewayFixQuitsOnlyAMagpie", "magpie-test-home-", "magpie-gateway-test-",
                        "magpie-library-test-", "magpie-auth-", "magpie-started-", "magpie-b-", "magpie-",
                        "zcode-bash-", "zcode-"):
                if name.startswith(pfx):
                    key = pfx + "*"; break
            groups.setdefault(key or name, [0, 0, 0.0]); g = groups[key or name]
            g[0] += s; g[1] += c; g[2] = max(g[2], b)
    except OSError:
        pass

# ---------- 5. 写报告 ----------
R = []
R.append(f"# 盘点报告 inventory — {TODAY}\n")
R.append(f"- C 盘：总 {fmt(du.total)}，可用 {fmt(du.free)}（执行前基线）")
R.append(f"- 扫描范围：`{HOME}`（对 C 盘只读；DB 经只读连接 backup 到 E 盘副本后读取）")
R.append(f"- 脱敏规则：sk- / gh?_ / AKIA / Bearer / password= / 私钥 / glm-长串 → `[REDACTED]`（短模型名如 glm-5.3 保留）\n")

R.append("## 1. 会话源盘点\n")
R.append("| 路径 | 工具 | 类别 | 大小 | 文件数 | 时间范围 | 风险级别 | 建议 | 是否需要退出程序 |")
R.append("|---|---|---|---|---|---|---|---|---|")
risk_map = {
    "claude": ("C", "先归档(raw/md)再谈清理；清了会减少 Magpie 历史统计", "否"),
    "codex":  ("C", "先归档再谈清理", "否"),
    "factory":("C", "先归档再谈清理", "否"),
    "kimi":   ("C", "先归档再谈清理", "否"),
    "cursor": ("C", "先归档再谈清理", "否"),
    "zcode":  ("B", "model-io-* 归档后保留最新，其余可清", "否"),
}
for (tool, root), (s, c, a, b) in sorted(stats_by_src.items()):
    rk, adv, ex = risk_map[tool]
    tr = f"{dstr(a)} ~ {dstr(b)}" if c else "-"
    R.append(f"| `{root}` | {tool} | 会话原始文件 | {fmt(s)} | {c} | {tr} | {rk} | {adv} | {ex} |")
R.append("")
R.append("### 1.1 Magpie sessions.json 收录对照\n")
R.append(f"- 索引条目 {idx_total}，其中失效（文件已不存在）{idx_stale}")
for tool in sorted(xref_count):
    m, u = xref_count[tool]
    R.append(f"- {tool}: 已收录 {m} / 未收录 {u}")
R.append(f"- 逐会话对照见 `{tsv.name}`（indexed_by_magpie=Y/N）\n")

R.append("## 2. ZCode 数据库结构（副本读取）\n")
for name, info in db_info.items():
    if info is None:
        R.append(f"### {name}\n- 源库不存在\n")
        continue
    R.append(f"### {name}（{fmt(info['size'])}，副本 `{info['copy']}`）\n")
    R.append("| 表 | 行数 | 字段 |")
    R.append("|---|---|---|")
    for t, rows, cols, _ in info["tables"]:
        cs = ", ".join(f"{c}({ty})" for c, ty in cols)
        R.append(f"| {t} | {rows} | {cs} |")
    R.append("")
    for t, rows, cols, samples in info["tables"]:
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
    R.append(f"| {label} | `{p}` | {fmt(s) if c else ('0（不存在）' if s==0 and c==0 else fmt(s))} | {c} | {tr} |")
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

# ---------- 控制台摘要 ----------
print("== 会话源 ==")
for (tool, root), (s, c, a, b) in sorted(stats_by_src.items()):
    print(f"  {tool:8s} {c:6d} files  {fmt(s):>10s}  {dstr(a)}~{dstr(b)}  {root}")
print("== Magpie 对照 ==")
print(f"  索引 {idx_total}（失效 {idx_stale}）")
for tool, (m, u) in sorted(xref_count.items()):
    print(f"  {tool:8s} 收录 {m} / 未收录 {u}")
print("== DB ==")
for name, info in db_info.items():
    if info is None:
        print(f"  {name}: 不存在"); continue
    print(f"  {name}: {fmt(info['size'])}, 表 {len(info['tables'])}")
    for t, rows, cols, _ in info["tables"]:
        print(f"     {t}: {rows} rows, cols=[{', '.join(c for c, _ in cols)}]")
print(f"== C 盘可用 {fmt(du.free)} / 总 {fmt(du.total)} ==")
print("== 用户目录 Top 15 ==")
for name, s, c, a, b in top[:15]:
    print(f"  {fmt(s):>10s}  {c:>8d}  {name}")
print("== 候选缓存明细 ==")
for label, p, s, c, a, b in cand_rows:
    if c:
        print(f"  {label:22s} {fmt(s):>10s} {c:>8d}")
print("== vhdx ==")
for p, s in sorted(vhdx, key=lambda r: -r[1]):
    print(f"  {fmt(s):>10s}  {p}")
print("== Temp 分组 Top 10 ==")
for key, (s, c, mt) in sorted(groups.items(), key=lambda kv: -kv[1][0])[:10]:
    print(f"  {fmt(s):>10s} {c:>8d}  {key}")
print(f"\n报告: {rep}")
print(f"对照表: {tsv}")
