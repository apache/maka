# -*- coding: utf-8 -*-
"""阶段3 dry-run：生成 A/B/C 分级清理方案（只读）。
产出：reports/cleanup_plan_<date>.md + reports/cleanup_actions_<date>.json（阶段4执行依据）。
"""
import os, json, datetime, shutil
from pathlib import Path
import sys
sys.path.insert(0, r"E:\cc\guahub\sessions\tools")
from scan_phase1b import parallel_stats, tree_stats, HOME, OUT, REPORTS, fmt, dstr

TODAY = datetime.date.today().isoformat()
NOW = datetime.datetime.now()
CUT14 = NOW - datetime.timedelta(days=14)
CUT30 = NOW - datetime.timedelta(days=30)
CUT2D = NOW - datetime.timedelta(days=2)

def mtime_of(p):
    try:
        return datetime.datetime.fromtimestamp(Path(p).stat().st_mtime)
    except OSError:
        return None

def children(base):
    try:
        return [e.path for e in os.scandir(base)
                if e.is_dir(follow_symlinks=False) and not e.is_symlink() and not e.is_junction()]
    except OSError:
        return []

def sub_size(base):
    """返回 base 下 Cache 类子目录 {名称: (size, cnt)} 与其余总大小"""
    base = Path(base)
    cache_names = {"Cache", "Code Cache", "GPUCache", "CachedData", "CachedExtensionVSIXs",
                   "logs", "Crashpad", "DawnGraphiteCache", "DawnWebGPUCache", "ShaderCache", "GrShaderCache"}
    hits = {}
    total = 0
    m = parallel_stats(children(base), f"cachesub:{base.name}") if base.exists() else {}
    for p, (s, c, a, b) in m.items():
        n = os.path.basename(p)
        total += s
        if n in cache_names and c:
            hits[n] = (s, c)
    return hits, total

ACTIONS = []
def add(level, path, size, cnt, reason, method, command=None):
    ACTIONS.append({"level": level, "path": str(path), "size": int(size), "files": int(cnt),
                    "reason": reason, "method": method, "command": command})

def main():
    # ---------- Temp 细化 ----------
    TEMP = HOME / "AppData/Local/Temp"
    tmap = parallel_stats(children(TEMP), "temp3")
    groups = {}
    for p, v in tmap.items():
        name = os.path.basename(p)
        mt = mtime_of(p)
        if name.startswith("magpie-test-home-") or name.startswith("TestGatewayFix"):
            key = "magpie-test-home-*/TestGatewayFix*（测试残留）"
        elif name.startswith("magpie-gateway-test-") or name.startswith("magpie-library-test-"):
            key = "magpie-*-test-*（测试残留）"
        elif name.startswith("magpie-auth-") or name.startswith("magpie-started-") or name.startswith("magpie-b-"):
            key = "magpie-auth/started/b-*（Magpie 可能占用→post_exit）"
        elif name.startswith("magpie-"):
            key = "magpie-其它（docs/png 等，单独看）"
        elif name.startswith("zcode-bash-"):
            key = "zcode-bash-*（ZCode 会话临时目录）"
        elif name.startswith("vscode-stable-user-x64"):
            key = "vscode-stable-user-x64-*（VS Code 安装器残留）"
        elif name.startswith("go-build"):
            key = "go-build*（Temp 内 Go 构建缓存残留）"
        elif name.startswith("nsu") and name.endswith(".tmp"):
            key = "nsu*.tmp（安装器残留）"
        else:
            key = name
        g = groups.setdefault(key, {"size": 0, "cnt": 0, "old": 0, "new": 0, "newest": None, "sample": p})
        g["size"] += v[0]; g["cnt"] += v[1]
        if mt:
            g["newest"] = max(g["newest"], mt) if g["newest"] else mt
            if mt < CUT2D: g["old"] += v[0]
            else: g["new"] += v[0]
    for p in TEMP.iterdir():
        if p.is_file():
            g = groups.setdefault(p.name, {"size": 0, "cnt": 0, "old": 0, "new": 0, "newest": None, "sample": p})
            try:
                st = p.stat()
            except OSError:
                continue
            g["size"] += st.st_size; g["cnt"] += 1
            mt = datetime.datetime.fromtimestamp(st.st_mtime)
            g["newest"] = max(g["newest"], mt) if g["newest"] else mt
            if mt < CUT2D: g["old"] += st.st_size
            else: g["new"] += st.st_size

    # A 级：Temp 明确安全项
    for key in ("magpie-test-home-*/TestGatewayFix*（测试残留）", "magpie-*-test-*（测试残留）",
                "go-build*（Temp 内 Go 构建缓存残留）", "nsu*.tmp（安装器残留）"):
        g = groups.get(key)
        if g and g["size"]:
            add("A", f"%TEMP%\\{key}", g["size"], g["cnt"], "测试/安装器残留，与运行中程序无关", "direct")
    for name in ("ZCode-installer.log", "ZCode-uninstaller.log"):
        g = groups.get(name)
        if g and g["size"]:
            add("A", f"%TEMP%\\{name}", g["size"], g["cnt"], "安装日志", "direct")
    g = groups.get("vscode-stable-user-x64-*（VS Code 安装器残留）")
    if g and g["size"]:
        add("A", "%TEMP%\\vscode-stable-user-x64-*", g["size"], g["cnt"],
            f"VS Code 安装器残留，最新 {dstr(g['newest'].timestamp())}", "direct")
    g = groups.get("zcode-bash-*（ZCode 会话临时目录）")
    if g and g["size"]:
        add("A", "%TEMP%\\zcode-bash-*", g["size"], g["cnt"],
            f"ZCode 会话临时目录；含当前运行会话，退出后删（2 天内 {g['new']//1048576}MB 也在内）", "post_exit")
    g = groups.get("magpie-auth/started/b-*（Magpie 可能占用→post_exit）")
    if g and g["size"]:
        add("A", "%TEMP%\\magpie-auth-*/started-*/b-*", g["size"], g["cnt"],
            "Magpie 认证/启动残留；Magpie 运行中，退出后删", "post_exit")
    # magpie-其它（docs/png 等散件）
    g = groups.get("magpie-其它（docs/png 等，单独看）")
    if g and g["size"]:
        add("B", "%TEMP%\\magpie-*.md/png 等", g["size"], g["cnt"], "散件资料，需人工确认", "manual")

    # ---------- A 级：其它明确项 ----------
    upd = HOME / "AppData/Local/@zcodedesktop-updater"
    if upd.exists():
        s, c, *_ = tree_stats(upd)
        add("A", upd, s, c, "ZCode 更新器已装安装包缓存", "direct")
    empty = HOME / "AppData/Roaming/magpie-windows-amd64.exe"
    if empty.exists() and not any(empty.iterdir()):
        add("A", empty, 0, 0, "误建空目录（与安装器同名的目录）", "direct")
    crash = HOME / ".zcode/v2/crash"
    if crash.exists():
        s, c, *_ = tree_stats(crash)
        add("A", crash, s, c, "崩溃转储，已无分析价值可删（如需排查再留）", "post_exit")
    icache = HOME / ".zcode/cli/image-cache"
    if icache.exists():
        s, c, *_ = tree_stats(icache)
        add("A", icache, s, c, "ZCode 图片缓存，可再生", "post_exit")

    # 14 天前日志
    old = new = 0; oldn = 0
    logdir = HOME / ".zcode/cli/log"
    for p in logdir.glob("*.jsonl"):
        try:
            d = datetime.datetime.strptime(p.stem.replace("zcode-", ""), "%Y-%m-%d")
        except ValueError:
            continue
        if d < CUT14:
            old += p.stat().st_size; oldn += 1
        else:
            new += p.stat().st_size
    if old:
        add("A", f"{logdir}\\*.jsonl（14 天前 {oldn} 个）", old, oldn, "CLI 日志，保留近 14 天", "direct")
    v2logs = HOME / ".zcode/v2/logs"
    if v2logs.exists():
        s, c, *_ = tree_stats(v2logs)
        old2 = new2 = 0; old2n = 0
        for p in v2logs.glob("*.log"):
            try:
                d = datetime.datetime.strptime(p.stem, "%Y-%m-%d")
            except ValueError:
                continue
            if d < CUT14:
                old2 += p.stat().st_size; old2n += 1
            else:
                new2 += p.stat().st_size
        if old2:
            add("A", f"{v2logs}\\*.log（14 天前 {old2n} 个）", old2, old2n, "桌面端日志，保留近 14 天", "direct")
        add("KEEP", f"{v2logs}\\近 14 天", new2, c - old2n, "保留", "-")

    # Roaming\ZCode 缓存（IndexedDB/Local Storage/Partitions 不动）
    hits, tot = sub_size(HOME / "AppData/Roaming/ZCode/session")
    cacheable = {k: v for k, v in hits.items() if k in ("Cache", "Code Cache", "GPUCache", "DawnGraphiteCache", "DawnWebGPUCache", "Crashpad")}
    if cacheable:
        s = sum(v[0] for v in cacheable.values()); c = sum(v[1] for v in cacheable.values())
        add("A", "Roaming\\ZCode\\session\\{Cache,Code Cache,GPUCache,...}", s, c,
            "Electron 壳缓存，可再生；IndexedDB/Local Storage/Partitions（登录态）不动", "post_exit")

    # 各 IDE 缓存
    for label, base in (("Cursor", HOME / "AppData/Roaming/Cursor"),
                        ("VS Code", HOME / "AppData/Roaming/Code")):
        hits, tot = sub_size(base)
        cacheable = {k: v for k, v in hits.items() if k not in ("logs",)}
        if cacheable:
            s = sum(v[0] for v in cacheable.values()); c = sum(v[1] for v in cacheable.values())
            add("A", f"{label}: {base}\\{{Cache,Code Cache,GPUCache,CachedData,CachedExtensionVSIXs,Crashpad}}", s, c,
                f"{label} 壳缓存，可再生（logs 单列 B）", "direct" if label == "Cursor" else "post_exit",
                command=None)
        if "logs" in hits:
            add("B", f"{label} logs", hits["logs"][0], hits["logs"][1], "编辑器日志，可清", "direct")
    # .trae-cn 的缓存类子目录
    trae = HOME / ".trae-cn"
    if trae.exists():
        hits, tot = sub_size(trae)
        cacheable = {k: v for k, v in hits.items() if k not in ("logs",)}
        if cacheable:
            s = sum(v[0] for v in cacheable.values()); c = sum(v[1] for v in cacheable.values())
            add("A", f".trae-cn 缓存类子目录", s, c, "Trae CN 壳缓存，可再生", "direct")

    # Claude 杂项
    hits, tot = sub_size(HOME / ".claude")
    for k, v in hits.items():
        if k in ("todos", "shell-snapshots", "debug", "statsig", "Crashpad"):
            add("A", f".claude\\{k}", v[0], v[1], "Claude Code 临时/调试产物，可再生", "direct")

    # 包管理器官方命令
    for label, path, cmd, note in (
        ("npm cache", HOME / "AppData/Local/npm-cache", "npm cache clean --force", "官方命令"),
        ("pnpm store", HOME / "AppData/Local/pnpm/store", "pnpm store prune", "官方命令，只清未引用包"),
        ("uv cache", HOME / "AppData/Local/uv", "uv cache prune", "官方命令"),
        ("pip cache", HOME / "AppData/Local/pip", "pip cache purge", "官方命令"),
        ("bun cache", HOME / ".bun/install/cache", "bun pm cache rm", "官方命令"),
        ("go build cache", HOME / "AppData/Local/go-build", "go clean -cache", "官方命令，下次构建会变慢一次"),
    ):
        if path.exists():
            s, c, *_ = tree_stats(path)
            add("A", f"{label}（{path}）", s, c, note, "command", command=cmd)

    # ---------- B 级 ----------
    ck = HOME / ".zcode/v2/checkpoints"
    if ck.exists():
        m = parallel_stats(children(ck), "checkpoints")
        old_s = old_c = new_s = new_c = 0
        for p, (s, c, a, b) in m.items():
            mt = mtime_of(p)
            if mt and mt < CUT30:
                old_s += s; old_c += c
            else:
                new_s += s; new_c += c
        if old_s:
            add("B", ".zcode\\v2\\checkpoints\\（30 天前任务）", old_s, old_c,
                "旧任务检查点，代价=失去对应回滚能力；ZCode 运行中→退出后删", "post_exit")
        add("KEEP", ".zcode\\v2\\checkpoints\\（30 天内）", new_s, new_c, "保留", "-")
    for p, why in ((HOME / ".zcode/cli/exec", "ZCode 执行现场，退出后清"),
                   (HOME / ".zcode/cli/artifacts", "会话产物已提炼入 md/raw，原文件可清")):
        if p.exists():
            s, c, *_ = tree_stats(p)
            add("B", p, s, c, why + "；ZCode 运行中", "post_exit")
    pnpm_cache = HOME / "AppData/Local/pnpm-cache"
    if pnpm_cache.exists():
        s, c, *_ = tree_stats(pnpm_cache)
        add("B", pnpm_cache, s, c, "pnpm 元数据缓存，删后按需重建", "command", command="rd /s /q（无官方命令）")
    mspl = HOME / "AppData/Local/ms-playwright"
    if mspl.exists():
        s, c, *_ = tree_stats(mspl)
        add("B", mspl, s, c, "Playwright 浏览器，项目还要用就留着（重下 1.5GB）", "manual")
    gomod = HOME / "go/pkg/mod"
    if gomod.exists():
        s, c, *_ = tree_stats(gomod)
        add("B", gomod, s, c, "Go 模块缓存，go clean -modcache 可清，重下耗时", "command", command="go clean -modcache")
    if (HOME / ".cache").exists():
        m = parallel_stats(children(HOME / ".cache"), "dotcache")
        for p, (s, c, a, b) in sorted(m.items(), key=lambda kv: -kv[1][0]):
            n = os.path.basename(p)
            if n == "magpie":
                continue  # 铁律：.cache\magpie\bun 不动；magpie 缓存整体跳过
            if s > 200 * 1048576:
                add("B", p, s, c, ".cache 下大户，需你逐项点头", "manual")
    # corrupt 设置备份（保留最新一份）
    corr = sorted((HOME / ".zcode/v2").glob("setting.json.corrupt-*"))
    if len(corr) > 1:
        s = sum(x.stat().st_size for x in corr[:-1])
        add("B", ".zcode\\v2\\setting.json.corrupt-*（除最新一份）", s, len(corr) - 1, "历史损坏备份，保留最新", "direct")
    # rollout model-io 保留最新
    ro = sorted((HOME / ".zcode/cli/rollout").glob("model-io-*.jsonl"), key=lambda x: x.stat().st_mtime)
    if len(ro) > 1:
        s = sum(x.stat().st_size for x in ro[:-1])
        add("B", ".zcode\\cli\\rollout\\model-io-*（除最新一份）", s, len(ro) - 1, "已归档(raw zip)，保留最新", "direct")

    # ---------- C 级 ----------
    ext_sessions = [
        ("claude", HOME / ".claude/projects"),
        ("codex", HOME / ".codex/sessions"),
        ("codex", HOME / ".codex/archived_sessions"),
        ("factory", HOME / ".factory/sessions"),
        ("kimi", HOME / ".kimi-code/sessions"),
        ("cursor", HOME / ".cursor/projects"),
    ]
    tot_s = tot_c = 0
    for tool, base in ext_sessions:
        if not base.exists():
            continue
        m = parallel_stats(children(base), f"c:{tool}") if base.name != "projects" or tool != "cursor" else parallel_stats(children(base), "c:cursor")
        os_s = os_c = ns = nc = 0
        for p, (s, c, a, b) in m.items():
            mt = mtime_of(p)
            if mt and mt < CUT30:
                os_s += s; os_c += c
            else:
                ns += s; nc += c
        tot_s += os_s; tot_c += os_c
        add("C", f"{tool}: {base}（30 天前部分）", os_s, os_c,
            "已 sha256 归档(raw zip)+提炼(md)；删后 Magpie 历史统计减少；magpie-snapshot 已备份索引", "post_exit")
        add("KEEP", f"{tool}: 30 天内", ns, nc, "保留", "-")
    dbs = HOME / ".zcode/cli/db/db.sqlite"
    if dbs.exists():
        add("C", str(dbs) + " VACUUM", 0, 0,
            "永不删除；实测 free pages≈117（<1MB），VACUUM 收益极小，建议跳过", "post_exit")

    # ---------- 补充发现（不在清单，需你点头）----------
    extra = []
    chrome = HOME / "AppData/Local/Google/Chrome/User Data"
    if chrome.exists():
        m = parallel_stats(children(chrome), "chrome")
        cs = cc = 0
        for p, (s, c, a, b) in m.items():
            hits, _ = sub_size(p)
            cs += sum(v[0] for k, v in hits.items() if k in ("Cache", "Code Cache", "GPUCache", "ShaderCache", "GrShaderCache", "Crashpad"))
            cc += sum(v[1] for k, v in hits.items() if k in ("Cache", "Code Cache", "GPUCache", "ShaderCache", "GrShaderCache", "Crashpad"))
        if cs:
            extra.append(("B", str(chrome) + "\\各 Profile 缓存", cs, cc, "Chrome 可再生缓存，需 Chrome 退出后清", "post_exit"))
    for p, note in ((HOME / "AppData/Local/Doubao", "豆包数据"),
                    (HOME / ".grok", "grok CLI 数据"),
                    (HOME / ".wechat-intelligence-hub", "微信智能数据"),
                    (HOME / ".workbuddy-ai", "workbuddy 数据"),
                    (HOME / "KimiData", "Kimi 桌面数据"),
                    (HOME / ".qoder", "qoder 数据"),
                    (HOME / ".rustup", "Rust 工具链"),
                    (HOME / ".cargo/registry", "cargo 注册表缓存"),
                    (TEMP / "multica-pg", "疑似 PostgreSQL 数据目录，务必确认没用再动"),
                    (TEMP / "guahub-review", "此前 review 工作残留"),
                    (TEMP / "go268-cache", "go 相关缓存残留"),
                    (TEMP / "DingTalkUpdate_v4_9.0.1.260920012-9.0.2.261011003", "钉钉更新包"),
                    (TEMP / "workbuddy-update-x64", "workbuddy 更新包")):
        if p.exists():
            s, c, *_ = tree_stats(p)
            extra.append(("manual", str(p), s, c, note, "manual"))

    # ---------- 汇总输出 ----------
    du = shutil.disk_usage("C:\\")
    a_s = sum(x["size"] for x in ACTIONS if x["level"] == "A")
    b_s = sum(x["size"] for x in ACTIONS if x["level"] == "B")
    c_s = sum(x["size"] for x in ACTIONS if x["level"] == "C")
    L = [f"# 清理方案（dry-run）— {TODAY}", "",
         f"- C 盘当前可用 {fmt(du.free)} / 总 {fmt(du.total)}",
         f"- A 级合计 {fmt(a_s)}；B 级合计 {fmt(b_s)}；C 级合计 {fmt(c_s)}（C 级主要为了台账清晰，金额另计）",
         "- 执行方式：direct=可直接移 _trash；post_exit=写入 post_exit_cleanup.ps1 退出 ZCode/Magpie 后跑；command=官方命令；manual=逐项等你点头", ""]
    for lv, title in (("A", "A 级（低风险）"), ("B", "B 级（中风险）"), ("C", "C 级（高风险）"), ("KEEP", "保留项")):
        L.append(f"## {title}")
        L.append("")
        L.append("| 路径 | 大小 | 文件数 | 理由 | 执行方式 | 命令 |")
        L.append("|---|---|---|---|---|---|")
        for x in ACTIONS:
            if x["level"] != lv:
                continue
            L.append(f"| `{x['path']}` | {fmt(x['size'])} | {x['files']} | {x['reason']} | {x['method']} | {x.get('command') or '-'} |")
        L.append("")
    L.append("## 补充发现（不在原清单，逐项等你点头）")
    L.append("")
    L.append("| 路径 | 大小 | 文件数 | 说明 |")
    L.append("|---|---|---|---|")
    for lv, p, s, c, note, _m in extra:
        L.append(f"| `{p}` | {fmt(s)} | {c} | {note} |")
    L.append("")
    (REPORTS / f"cleanup_plan_{TODAY}.md").write_text("\n".join(L), encoding="utf-8")
    (REPORTS / f"cleanup_actions_{TODAY}.json").write_text(
        json.dumps({"date": TODAY, "c_free_before": du.free, "actions": ACTIONS, "extra": extra},
                   ensure_ascii=False, indent=1), encoding="utf-8")

    print(f"C 盘可用 {fmt(du.free)}")
    print(f"A 级 {fmt(a_s)} / B 级 {fmt(b_s)} / C 级 {fmt(c_s)}")
    print("--- A 级明细 ---")
    for x in ACTIONS:
        if x["level"] == "A":
            print(f"  [{x['method']:9s}] {fmt(x['size']):>9s} {x['path'][:90]}")
    print("--- B 级明细 ---")
    for x in ACTIONS:
        if x["level"] == "B":
            print(f"  [{x['method']:9s}] {fmt(x['size']):>9s} {x['path'][:90]}")
    print("--- C 级明细 ---")
    for x in ACTIONS:
        if x["level"] == "C":
            print(f"  [{x['method']:9s}] {fmt(x['size']):>9s} {x['path'][:90]}")
    print("--- 补充发现 ---")
    for lv, p, s, c, note, _m in extra:
        print(f"  {fmt(s):>9s}  {p[:80]}  — {note}")

if __name__ == "__main__":
    main()
