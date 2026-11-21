# -*- coding: utf-8 -*-
"""阶段2：归档与提炼（只写 E:\\cc\\guahub\\sessions）。
- snapshot: magpie sessions.json / sessions-wsl.json / usage.jsonl 副本（不含凭据）
- archive:  会话原始文件按 工具/月 打 zip，sha256 入 manifest（幂等：manifest 已有即跳过）
- extract:  各工具解析为标准化 md（frontmatter + 用户提问 + 助手最终结论）
- prompts:  提示词库（归一化聚类，相似度>0.85 合并）
- snippets: 回复精华（报错解决方案/命令与脚本/技术选型/环境配置）
- index:    总索引
C 盘只读；ZCode 会话从 db.sqlite 只读副本提取（每轮重新 backup）。
"""
import os, re, json, zlib, shutil, sqlite3, hashlib, datetime, zipfile, difflib
from pathlib import Path
from collections import Counter, defaultdict

HOME = Path(r"C:\Users\802165")
OUT = Path(r"E:\cc\guahub\sessions")
REPORTS = OUT / "reports"
DBTMP = OUT / "_tmp" / "db"
TODAY = datetime.date.today().isoformat()
MANIFEST = OUT / "manifest.jsonl"
TSV = REPORTS / f"sessions_crossref_{TODAY}.tsv"

RE_PATH = re.compile(r"(?:[A-Za-z]:[\\/])?(?:[\w.\- ]+[\\/])+[\w.\- ]*")
RE_UUID = re.compile(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")
RE_HEX = re.compile(r"\b[0-9a-f]{16,64}\b")
RE_ERR = re.compile(r"(?:Error|Exception|FATAL|panic|failed to|失败|报错|错误|无法|不生效)", re.I)

NOISE_PREFIX = (
    "The TodoWrite tool hasn't been used recently",
    "<system-reminder>", "system-reminder>", "Caveat:",
    "<user_instructions>", "<environment_context>", "<turn_context>",
    "[Request interrupted", "<bash-input>", "<bash-stdout>", "<bash-stderr>",
    "<local-command", "<command-name>", "<command-message>", "<command-args>",
    "API Error", "This session is being continued",
)
RE_HARNESS = re.compile(r"^\[\d+\]\s+(tool|user|assistant|system)\b")
def is_noise(t):
    t = t.lstrip()
    return t.startswith(NOISE_PREFIX) or bool(RE_HARNESS.match(t))

def as_dict(x):
    return x if isinstance(x, dict) else {}

def _int(x):
    try:
        return int(x or 0)
    except (TypeError, ValueError):
        return 0

def sha256(p, buf=1 << 20):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        while True:
            b = f.read(buf)
            if not b:
                break
            h.update(b)
    return h.hexdigest()

def fold(t, n):
    if t is None:
        return ""
    t = str(t).strip()
    return t if len(t) <= n else t[: n - 6] + "…（截断）"

def slug(s, n=80):
    s = re.sub(r"[^A-Za-z0-9._-]+", "-", str(s)).strip("-")
    return s[:n] or "unknown"

def month_of(mtime):
    return datetime.datetime.fromtimestamp(mtime).strftime("%Y-%m")

def iso_of(ms):
    try:
        return datetime.datetime.fromtimestamp(int(ms) / 1000).strftime("%Y-%m-%d %H:%M:%S")
    except Exception:
        return "-"

def load_tsv():
    rows = []
    with open(TSV, encoding="utf-8") as f:
        next(f)
        for line in f:
            tool, path, size, mdate, idx = line.rstrip("\n").split("\t")
            rows.append({"tool": tool, "path": Path(path), "size": int(size), "magpie": idx})
    return rows

def load_manifest():
    done = {}
    if MANIFEST.exists():
        with open(MANIFEST, encoding="utf-8") as f:
            for line in f:
                try:
                    r = json.loads(line)
                    done[(r["source"], r["sha256"])] = r
                except Exception:
                    pass
    return done

def manifest_append(rec):
    with open(MANIFEST, "a", encoding="utf-8") as f:
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")

ARC_PREFIX = {
    "claude": (HOME / ".claude", "claude/projects"),
    "codex": (HOME / ".codex", "codex"),
    "factory": (HOME / ".factory", "factory"),
    "kimi": (HOME / ".kimi-code", "kimi-code"),
    "cursor": (HOME / ".cursor", "cursor"),
    "zcode": (HOME / ".zcode", "zcode"),
}

def snapshot_and_archive(rows, done):
    """magpie 快照 + 会话文件按月打包。返回 archive 索引 {path: rec}"""
    stats = Counter()
    # 1) magpie 快照（只复制，不动 C 盘）
    snapdir = OUT / "magpie-snapshot" / TODAY
    snapdir.mkdir(parents=True, exist_ok=True)
    for name in ("sessions.json", "sessions-wsl.json", "usage.jsonl"):
        src = HOME / ".cache" / "magpie" / name
        if not src.exists():
            continue
        h = sha256(src)
        if (str(src), h) in done:
            stats["snapshot_skipped"] += 1
            continue
        dst = snapdir / name
        shutil.copy2(src, dst)
        manifest_append({"source": str(src), "sha256": h, "size": src.stat().st_size,
                         "mtime": datetime.datetime.fromtimestamp(src.stat().st_mtime).isoformat(),
                         "tool": "magpie", "archive": f"magpie-snapshot/{TODAY}/{name}",
                         "md": None, "magpie": "-", "status": "ok"})
        stats["snapshot_copied"] += 1

    # 2) 会话文件按 工具/月 打包
    zips = {}
    arc_index = {}
    for r in rows:
        p = r["path"]
        if not p.exists():
            manifest_append({"source": str(p), "sha256": "-", "size": r["size"], "mtime": "-",
                             "tool": r["tool"], "archive": None, "md": None,
                             "magpie": r["magpie"], "status": "missing"})
            stats["missing"] += 1
            continue
        h = sha256(p)
        key = (str(p), h)
        if key in done:
            arc_index[str(p)] = done[key]
            stats["archive_skipped"] += 1
            continue
        tool = r["tool"]
        m = month_of(p.stat().st_mtime)
        zipname = f"raw/{tool}/{m}.zip"
        base, prefix = ARC_PREFIX[tool]
        try:
            arcname = prefix + "/" + p.relative_to(base).as_posix()
        except ValueError:
            arcname = prefix + "/" + p.name
        Path(OUT / zipname).parent.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(OUT / zipname, "a", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
            if arcname not in z.namelist():
                z.write(p, arcname)
        rec = {"source": str(p), "sha256": h, "size": r["size"],
               "mtime": datetime.datetime.fromtimestamp(p.stat().st_mtime).isoformat(),
               "tool": tool, "archive": f"{zipname}!{arcname}", "md": None,
               "magpie": r["magpie"], "status": "ok"}
        manifest_append(rec)
        arc_index[str(p)] = rec
        stats["archived"] += 1
        stats["archived_bytes"] += r["size"]
    return arc_index, stats

def fresh_db_backup():
    for name, src in (("zcode-cli-db", HOME / ".zcode/cli/db/db.sqlite"),
                      ("zcode-tasks-index", HOME / ".zcode/v2/tasks-index.sqlite")):
        dst = DBTMP / f"{name}.sqlite"
        con = sqlite3.connect(src.as_uri() + "?mode=ro", uri=True)
        b = sqlite3.connect(str(dst))
        con.backup(b)
        b.close(); con.close()
        print(f"  db backup ok: {name} {src.stat().st_size//1048576}MB")

# ---------- 各工具解析器：返回 SessionRec ----------
def new_rec(tool, sid):
    return {"id": sid, "tool": tool, "cwd": "", "model": "", "start": None, "end": None,
            "turns": 0, "tokens_in": 0, "tokens_out": 0,
            "prompts": [], "finals": [], "tools": Counter()}

def blocks_text(content, want_types):
    out = []
    if isinstance(content, str):
        if "text" in want_types:
            out.append(content)
        return out
    if isinstance(content, list):
        for b in content:
            if isinstance(b, dict):
                t = b.get("type")
                if t in want_types and b.get("text"):
                    out.append(b["text"])
            elif isinstance(b, str) and "text" in want_types and b.strip():
                out.append(b)
    return out

def parse_claude(path):
    rec = None
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            try:
                o = json.loads(line)
            except Exception:
                continue
            if not isinstance(o, dict):
                continue
            if o.get("isSidechain"):
                continue
            t = o.get("type")
            if t not in ("user", "assistant"):
                continue
            if rec is None:
                rec = new_rec("claude", o.get("sessionId") or path.stem)
                rec["cwd"] = o.get("cwd") or ""
            ts = o.get("timestamp")
            if ts:
                rec["start"] = rec["start"] or ts
                rec["end"] = ts
            msg = as_dict(o.get("message"))
            content = msg.get("content")
            if t == "user":
                texts = blocks_text(content, {"text"})
                for x in texts:
                    if x.strip() and not is_noise(x):
                        rec["prompts"].append(x)
                        rec["turns"] += 1
            else:
                rec["model"] = rec["model"] or msg.get("model") or ""
                texts = blocks_text(content, {"text"})
                for x in texts:
                    if x.strip():
                        rec["finals"].append(x)
                if isinstance(content, list):
                    for b in content:
                        if isinstance(b, dict) and b.get("type") == "tool_use":
                            rec["tools"][b.get("name", "?")] += 1
                u = msg.get("usage") or {}
                rec["tokens_in"] += (u.get("input_tokens") or 0) + (u.get("cache_read_input_tokens") or 0) \
                    + (u.get("cache_creation_input_tokens") or 0)
                rec["tokens_out"] += u.get("output_tokens") or 0
    return rec

def open_text(p):
    """明文或 zstd 压缩的会话文件统一按文本流打开（Python 3.14 内置 compression.zstd）"""
    if str(p).endswith(".zst"):
        import io
        from compression import zstd
        return io.TextIOWrapper(zstd.open(str(p), "rb"), encoding="utf-8", errors="replace")
    return open(p, encoding="utf-8", errors="replace")

CODEX_SKIP_PREFIX = ("<user_instructions>", "<environment_context>", "<turn_context>", "# AGENTS", "<permissions")

def parse_codex(path):
    rec = None
    with open_text(path) as f:
        for line in f:
            try:
                o = json.loads(line)
            except Exception:
                continue
            if not isinstance(o, dict):
                continue
            ty = o.get("type")
            ts = o.get("timestamp")
            if ty == "session_meta":
                pay = as_dict(o.get("payload"))
                if rec is None:
                    rec = new_rec("codex", pay.get("id") or pay.get("session_id") or path.stem)
                    rec["cwd"] = pay.get("cwd") or ""
                    if ts:
                        rec["start"] = rec["start"] or ts
                continue
            if rec is None:
                rec = new_rec("codex", path.stem)
            if ts:
                rec["start"] = rec["start"] or ts
                rec["end"] = ts
            if ty == "turn_context":
                rec["model"] = rec["model"] or as_dict(o.get("payload")).get("model") or ""
                continue
            if ty != "response_item":
                continue
            pay = as_dict(o.get("payload"))
            pt = pay.get("type")
            if pt == "message":
                role = pay.get("role")
                texts = []
                for b in pay.get("content") or []:
                    if isinstance(b, dict) and b.get("text"):
                        texts.append(b["text"])
                for x in texts:
                    if role == "user" and not x.startswith(CODEX_SKIP_PREFIX) and not is_noise(x):
                        rec["prompts"].append(re.sub(r"^\s*user:\s+", "", x)); rec["turns"] += 1
                    elif role == "assistant":
                        rec["finals"].append(x)
            elif pt in ("function_call", "local_shell_call", "custom_tool_call", "web_search_call"):
                rec["tools"][pay.get("name") or pt] += 1
            elif pt == "event_msg" and (pay.get("type") == "token_count"):
                info = as_dict(pay.get("info") or pay)
                tu = as_dict(info.get("total_token_usage") or info)
                rec["tokens_in"] += _int(tu.get("input_tokens") or tu.get("input"))
                rec["tokens_out"] += _int(tu.get("output_tokens") or tu.get("output"))
    return rec

def parse_factory(path):
    rec = None
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            try:
                o = json.loads(line)
            except Exception:
                continue
            if not isinstance(o, dict):
                continue
            ty = o.get("type")
            if ty == "session_start":
                rec = new_rec("factory", o.get("id") or path.stem)
                rec["cwd"] = o.get("cwd") or ""
                continue
            if ty != "message":
                continue
            if str(o.get("id", "")).startswith("context-"):
                continue
            msg = as_dict(o.get("message"))
            if msg.get("visibility") == "llm_only":
                continue
            role = msg.get("role")
            ts = o.get("timestamp")
            if rec is None:
                rec = new_rec("factory", path.stem)
            if ts:
                rec["start"] = rec["start"] or ts
                rec["end"] = ts
            if role == "user":
                for x in blocks_text(msg.get("content"), {"text"}):
                    if x.strip() and not is_noise(x):
                        rec["prompts"].append(x); rec["turns"] += 1
            elif role == "assistant":
                content = msg.get("content")
                for x in blocks_text(content, {"text"}):
                    if x.strip():
                        rec["finals"].append(x)
                if isinstance(content, list):
                    for b in content:
                        if isinstance(b, dict) and b.get("type") == "tool_use":
                            rec["tools"][b.get("name", "?")] += 1
    return rec

def parse_kimi(path):
    rec = None
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            try:
                o = json.loads(line)
            except Exception:
                continue
            if not isinstance(o, dict):
                continue
            ty = o.get("type")
            if rec is None:
                rec = new_rec("kimi", path.parent.parent.name.replace("session_", ""))
            if ty == "turn.prompt":
                for b in o.get("input") or []:
                    txt = b.get("text") if isinstance(b, dict) else b
                    if isinstance(txt, str) and txt.strip() and not is_noise(txt):
                        rec["prompts"].append(txt); rec["turns"] += 1
            elif ty == "context.append_message":
                m = as_dict(o.get("message"))
                if m.get("role") == "user":
                    for x in blocks_text(m.get("content"), {"text"}):
                        if x.strip() and not is_noise(x) and x not in rec["prompts"]:
                            rec["prompts"].append(x); rec["turns"] += 1
                elif m.get("role") == "assistant":
                    for x in blocks_text(m.get("content"), {"text"}):
                        if x.strip():
                            rec["finals"].append(x)
            elif ty == "usage.record":
                rec["model"] = rec["model"] or o.get("model") or ""
                u = as_dict(o.get("usage"))
                rec["tokens_in"] += (u.get("inputOther") or 0) + (u.get("inputCacheRead") or 0) + (u.get("inputCacheCreation") or 0)
                rec["tokens_out"] += u.get("output") or 0
                tm = o.get("time")
                if tm:
                    d = datetime.datetime.fromtimestamp(int(tm) / 1000).strftime("%Y-%m-%dT%H:%M:%S")
                    rec["start"] = rec["start"] or d
                    rec["end"] = d
    return rec

CURSOR_Q = re.compile(r"<user_query>\s*(.*?)\s*</user_query>", re.S)

def parse_cursor(path):
    rec = new_rec("cursor", path.parent.name)
    mt = path.stat().st_mtime
    d = datetime.datetime.fromtimestamp(mt).strftime("%Y-%m-%dT%H:%M:%S")
    rec["start"] = rec["end"] = d
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            try:
                o = json.loads(line)
            except Exception:
                continue
            if not isinstance(o, dict):
                continue
            role = o.get("role")
            content = as_dict(o.get("message")).get("content")
            if role == "user":
                for x in blocks_text(content, {"text"}):
                    for m in CURSOR_Q.finditer(x):
                        if m.group(1).strip() and not is_noise(m.group(1)):
                            rec["prompts"].append(m.group(1)); rec["turns"] += 1
                    if "<user_query>" not in x and x.strip() and not is_noise(x):
                        rec["prompts"].append(x); rec["turns"] += 1
            elif role == "assistant":
                for x in blocks_text(content, {"text"}):
                    if x.strip():
                        rec["finals"].append(x)
                if isinstance(content, list):
                    for b in content:
                        if isinstance(b, dict) and b.get("type") == "tool_use":
                            rec["tools"][b.get("name", "?")] += 1
    return rec

def parse_zcode_db(copy):
    b = sqlite3.connect(str(copy))
    cur = b.cursor()
    usage = {}
    for sid, ti, to in cur.execute(
            "SELECT session_id, SUM(input_tokens+cache_creation_input_tokens+cache_read_input_tokens), SUM(output_tokens) "
            "FROM model_usage GROUP BY session_id"):
        usage[sid] = (ti or 0, to or 0)
    models = {}
    for sid, mid, c in cur.execute(
            "SELECT session_id, model_id, COUNT(*) FROM model_usage GROUP BY session_id, model_id"):
        if sid not in models or c > models[sid][1]:
            models[sid] = (mid, c)
    role_of = {}
    for mid, sid, data in cur.execute("SELECT id, session_id, data FROM message"):
        try:
            role_of[mid] = (sid, (json.loads(data) or {}).get("role"))
        except Exception:
            role_of[mid] = (sid, None)
    recs = {}
    order = []
    for sid, tc, tu, directory, deleted in cur.execute(
            "SELECT id, time_created, time_updated, directory, time_deleted FROM session"):
        if deleted:
            continue
        r = new_rec("zcode", sid)
        r["cwd"] = directory or ""
        r["start"] = iso_of(tc); r["end"] = iso_of(tu)
        ti, to = usage.get(sid, (0, 0))
        r["tokens_in"], r["tokens_out"] = ti or 0, to or 0
        r["model"] = (models.get(sid) or ("", 0))[0] or ""
        recs[sid] = r
        order.append(sid)
    for sid, mid, pdata in cur.execute(
            "SELECT session_id, message_id, data FROM part ORDER BY session_id, time_created, rowid"):
        msid, role = role_of.get(mid, (sid, None))
        r = recs.get(msid)
        if r is None:
            continue
        try:
            pd = json.loads(pdata) or {}
        except Exception:
            continue
        if pd.get("type") == "text" and pd.get("text"):
            if role == "user":
                if not is_noise(pd["text"]):
                    r["prompts"].append(pd["text"]); r["turns"] += 1
            elif role == "assistant":
                r["finals"].append(pd["text"])
        elif pd.get("type") in ("tool", "tool_use", "tool-call") :
            r["tools"][pd.get("tool") or pd.get("name") or pd.get("type")] += 1
    b.close()
    return [recs[s] for s in order]

# ---------- md 生成 ----------
def project_of(rec):
    cwd = rec.get("cwd") or ""
    return slug(cwd or "unknown")

def write_md(rec, src, magpie):
    if not rec["prompts"] and not rec["finals"]:
        return None
    proj = project_of(rec)
    date = (rec.get("start") or "-")[:10]
    if not re.match(r"\d{4}-\d{2}-\d{2}", date):
        date = "unknown-date"
    rel = OUT / "md" / rec["tool"] / proj / f"{date}_{rec['id'][:8]}.md"
    rel.parent.mkdir(parents=True, exist_ok=True)
    L = ["---",
         f"tool: {rec['tool']}",
         f"project: {proj}",
         f"cwd: {rec.get('cwd','')}",
         f"model: {fold(rec.get('model',''),80) or 'unknown'}",
         f"start: {rec.get('start') or '-'}",
         f"end: {rec.get('end') or '-'}",
         f"turns: {rec['turns']}",
         f"tokens_in: {rec['tokens_in']}",
         f"tokens_out: {rec['tokens_out']}",
         f"indexed_by_magpie: {magpie}",
         f"source: {src}",
         "---", ""]
    L.append(f"# {fold(rec['prompts'][0] if rec['prompts'] else rec['id'], 100)}\n")
    L.append(f"## 用户提问（{len(rec['prompts'])} 条）\n")
    show = rec["prompts"][:50]
    for i, p in enumerate(show, 1):
        L.append(f"### Q{i}")
        L.append(fold(p, 1500))
        L.append("")
    if len(rec["prompts"]) > 50:
        L.append(f"（其余 {len(rec['prompts'])-50} 条见 raw 原始文件）\n")
    L.append("## 助手最终结论\n")
    finals = [x for x in rec["finals"] if len(x) >= 30][-3:]
    if not finals:
        L.append("（无实质文本结论）\n")
    for i, x in enumerate(finals, 1):
        L.append(f"### A{i}")
        L.append(fold(x, 2000))
        L.append("")
    if rec["tools"]:
        top = "，".join(f"{k}×{v}" for k, v in rec["tools"].most_common(10))
        L.append(f"## 工具调用摘要\n\n{top}\n")
    rel.write_text("\n".join(L), encoding="utf-8")
    return rel.relative_to(OUT).as_posix()

# ---------- 提示词库 ----------
def categorize(t):
    tl = t.lower()
    rules = [
        ("提示词工程", ("prompt", "提示词", "skill", "subagent", "系统提示", "meta-")),
        ("代码审查", ("review", "审查", "审计", "hunt", "code review")),
        ("测试", ("test", "测试", "用例", "单测", "tdd")),
        ("重构", ("refactor", "重构", "优化结构", "简化")),
        ("文档", ("文档", "doc", "readme", "注释", "changelog", "手册")),
        ("部署运维", ("部署", "发布", "上线", "运维", "ci", "docker", "nginx", "服务器")),
        ("调试排错", ("error", "报错", "失败", "bug", "排查", "修复", "fix", "崩溃", "exception", "不生效", "挂了")),
        ("需求拆解", ("需求", "拆解", "规划", "方案", "设计", "排期", "prd", "梳理")),
    ]
    for name, kws in rules:
        if any(k in tl for k in kws):
            return name
    return "其他"

def normalize_prompt(t):
    t = RE_PATH.sub("{{路径}}", t)
    t = RE_UUID.sub("{{ID}}", t)
    t = RE_HEX.sub("{{ID}}", t)
    return re.sub(r"\s+", " ", t).strip()[:600]

def build_prompts(all_recs):
    bag = {}
    for rec in all_recs:
        date = (rec.get("start") or "-")[:10]
        for p in rec["prompts"]:
            if len(p) < 8 or len(p) > 4000:
                continue
            np_ = normalize_prompt(p)
            if len(np_) < 8:
                continue
            e = bag.setdefault(np_, {"n": 0, "src": []})
            e["n"] += 1
            tag = f"{rec['tool']}/{rec['id'][:8]} ({date})"
            if tag not in e["src"] and len(e["src"]) < 5:
                e["src"].append(tag)
    cats = defaultdict(list)
    for text, e in bag.items():
        cats[categorize(text)].append((text, e))
    L = ["# 提示词库", "",
         f"- 生成：{TODAY}；来源：全部已归档会话的用户提问",
         "- 归一化：绝对路径→`{{路径}}`，UUID/长十六进制→`{{ID}}`；相似度>0.85 已合并（difflib）",
         "- 每类最多 15 条，按使用频次排序", ""]
    total_clusters = 0
    for cat in ["需求拆解", "调试排错", "代码审查", "重构", "测试", "文档", "部署运维", "提示词工程", "其他"]:
        items = sorted(cats.get(cat, []), key=lambda x: -x[1]["n"])
        uniq = [it for it in items]
        merged = []
        for text, e in uniq[:400]:
            hit = None
            for m in merged:
                if abs(len(m[0]) - len(text)) > 120:
                    continue
                if difflib.SequenceMatcher(None, m[0], text).ratio() > 0.85:
                    hit = m; break
            if hit:
                hit[1]["n"] += e["n"]
                hit[1]["src"] += [s for s in e["src"] if s not in hit[1]["src"]][:5 - len(hit[1]["src"])]
            else:
                merged.append([text, dict(e)])
        merged.sort(key=lambda m: -m[1]["n"])
        L.append(f"## {cat}（{len(uniq)} 条独立提问，合并后 {len(merged)} 模板）\n")
        for text, e in merged[:15]:
            total_clusters += 1
            L.append(f"### （{e['n']} 次）{fold(text, 90)}")
            L.append(f"- 模板：`{fold(text, 400)}`")
            L.append(f"- 使用次数：{e['n']}")
            L.append(f"- 来源：{'；'.join(e['src'][:3])}")
            L.append("")
    (OUT / "prompts").mkdir(exist_ok=True)
    (OUT / "prompts" / "prompt-library.md").write_text("\n".join(L), encoding="utf-8")
    return total_clusters, len(bag)

# ---------- 精华 ----------
THEME_RULES = [
    ("报错解决方案", lambda t, c: RE_ERR.search(t) and re.search(r"解决|修复|原因|root cause|定位", t, re.I)),
    ("技术选型", lambda t, c: re.search(r"选型|更推荐|更适合|选择.{0,12}因为|对比.{0,20}(优|好)|不建议", t)),
    ("环境配置", lambda t, c: re.search(r"安装|配置|环境变量|初始化|启用|接入|开通", t)),
    ("命令与脚本", lambda t, c: c),
]
SNIPPET_CAP = 30

def build_snippets(all_recs):
    if (OUT / "snippets").exists():
        shutil.rmtree(OUT / "snippets")
    written = Counter()
    for rec in all_recs:
        if not rec["finals"]:
            continue
        final = rec["finals"][-1]
        if len(final) < 80:
            continue
        date = (rec.get("start") or "-")[:10]
        if not re.match(r"\d{4}-\d{2}-\d{2}", date):
            continue
        has_code = "```" in final
        for theme, rule in THEME_RULES:
            if written[theme] >= SNIPPET_CAP or not rule(final, has_code):
                continue
            written[theme] += 1
            d = OUT / "snippets" / theme
            d.mkdir(parents=True, exist_ok=True)
            fn = d / f"{date}_{rec['tool']}_{rec['id'][:8]}.md"
            fn.write_text("\n".join([
                f"# {theme} — {fold(final,60)}",
                "",
                f"- 标签：{theme}",
                f"- 日期：{date}",
                f"- 来源：{rec['tool']} 会话 {rec['id'][:8]}（{rec.get('cwd') or 'cwd未知'}）",
                f"- 置信度：机器初筛候选，采纳前请对照原会话",
                "",
                "## 触发上下文（用户最后一问）",
                "",
                fold(rec["prompts"][-1] if rec["prompts"] else "（无）", 300),
                "",
                "## 结论",
                "",
                fold(final, 3000),
                "",
            ]), encoding="utf-8")
            break
    return written

# ---------- 索引 ----------
def build_index(stats, per_tool_files, per_tool_sessions, projects, snippet_counts, cluster_count):
    L = ["# sessions 归档索引", "", f"- 更新：{TODAY}", "",
         "## 按工具", "",
         "| 工具 | 会话数 | md 数 | 原始月度包 |", "|---|---|---|---|"]
    for tool in sorted(per_tool_sessions):
        zcount = len(list((OUT / "raw" / tool).glob("*.zip"))) if (OUT / "raw" / tool).exists() else 0
        L.append(f"| {tool} | {per_tool_sessions[tool]} | {per_tool_files[tool]} | raw/{tool}/（{zcount} 个 zip） |")
    L += ["", "## 按项目（md 落盘的项目）", "", "| 工具/项目 | 会话数 |", "|---|---|"]
    for (tool, proj), c in sorted(projects.items(), key=lambda kv: -kv[1])[:60]:
        L.append(f"| {tool}/{proj} | {c} |")
    L += ["", "## 按月份（原始包）", ""]
    zips = sorted(OUT.glob("raw/*/*.zip"))
    for z in zips:
        L.append(f"- `{z.relative_to(OUT).as_posix()}` — {z.stat().st_size//1048576} MB")
    L += ["", "## 提示词与精华", "",
          f"- 提示词库：prompts/prompt-library.md（{cluster_count} 个模板）",
          "- 回复精华：" + "，".join(f"{k} {v}" for k, v in sorted(snippet_counts.items()))]
    (OUT / "index.md").write_text("\n".join(L), encoding="utf-8")

# ---------- 主流程 ----------
def main():
    rows = load_tsv()
    done = load_manifest()
    print(f"manifest 既有 {len(done)} 条，会话文件 {len(rows)}")
    arc_index, astat = snapshot_and_archive(rows, done)
    print("归档：", {k: v for k, v in astat.items()})

    fresh_db_backup()

    per_tool_files = Counter(); per_tool_sessions = Counter(); projects = Counter()
    all_recs = []
    ok = fail = 0
    fails = []
    parsers = {"claude": parse_claude, "codex": parse_codex, "factory": parse_factory,
               "kimi": parse_kimi, "cursor": parse_cursor}
    for r in rows:
        p = r["path"]
        if r["tool"] == "zcode":
            continue
        try:
            rec = parsers[r["tool"]](p)
        except Exception as e:
            fail += 1
            fails.append(f"{r['tool']}\t{p.name}\t{type(e).__name__}: {e}")
            continue
        if rec is None:
            continue
        ok += 1
        all_recs.append(rec)
        per_tool_sessions[r["tool"]] += 1
        md = write_md(rec, str(p), r["magpie"])
        if md:
            per_tool_files[r["tool"]] += 1
            projects[(r["tool"], project_of(rec))] += 1
            old = arc_index.get(str(p))
            if old and not old.get("md"):
                old["md"] = md
                manifest_append({**old, "md": md})
    # zcode from db
    zr = parse_zcode_db(DBTMP / "zcode-cli-db.sqlite")
    for rec in zr:
        per_tool_sessions["zcode"] += 1
        all_recs.append(rec)
        md = write_md(rec, f"zcode-db:{rec['id']}", "N")
        if md:
            per_tool_files["zcode"] += 1
            projects[("zcode", project_of(rec))] += 1
    print(f"解析：文件成功 {ok} 失败 {fail}；zcode 会话 {len(zr)}")
    if fails:
        (REPORTS / f"parse_failures_{TODAY}.txt").write_text("\n".join(fails), encoding="utf-8")
    print("md 生成：", dict(per_tool_files))

    cluster_count, prompt_total = build_prompts(all_recs)
    print(f"提示词：原始 {prompt_total}（归一化后），模板 {cluster_count}")
    sc = build_snippets(all_recs)
    print("精华：", dict(sc))

    build_index(astat, per_tool_files, per_tool_sessions, projects, sc, cluster_count)
    rep = REPORTS / f"archive_{TODAY}.md"
    rep.write_text("\n".join([
        f"# 归档提炼报告 — {TODAY}",
        "",
        f"- 归档：本次新打包 {astat.get('archived',0)} 个文件（{astat.get('archived_bytes',0)//1048576} MB），快照 {astat.get('snapshot_copied',0)}，既有跳过 {astat.get('archive_skipped',0)+astat.get('snapshot_skipped',0)}，缺失 {astat.get('missing',0)}",
        f"- 解析：外部工具文件成功 {ok}，失败 {fail}；ZCode 会话（db 副本）{len(zr)}",
        f"- md：{dict(per_tool_files)}",
        f"- 提示词：归一化去重后 {prompt_total} 条 → 模板 {cluster_count} 个",
        f"- 精华：{dict(sc)}（机器初筛候选，需人工复核）",
        "",
        "解析说明：claude/codex/factory/kimi/cursor 为流式 JSONL 解析；cursor 无时间戳（取文件 mtime）；",
        "kimi 的 token 取 usage.record 汇总；codex 的 token 依赖 token_count 事件（可能为 0）；",
        "zcode 从 db.sqlite 副本 session+message+part 关联提取，prompt=role:user 的 text part，final=最后 3 段 assistant text。",
    ]), encoding="utf-8")
    print(f"报告: {rep}")

if __name__ == "__main__":
    main()
