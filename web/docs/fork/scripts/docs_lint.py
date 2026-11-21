#!/usr/bin/env python3
"""fork/docs 一致性检查（只读，仅标准库）。

用法：python3 scripts/docs_lint.py [docs 根目录，默认为本脚本上一级]
退出码：阻断项（LINK、TABLE、COUNT）非零即 1；告警项（SIZE、ORDER）只打印不阻断。

检查范围跳过 issues/（原件）、_archive/（只读封存）、journal/编年/（只追加历史，不回写）。
规则来源：handbook/10 §1 体积预算、§6 在途快照倒序、§9 链接复核；handbook/12 台账生成统计。
"""
import os, re, sys, urllib.parse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ledger_stats

ROOT = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), '..'))
SKIP = ('/issues/', '/_archive/', '/编年/')
# 出池仓台账行内的失效链接按台账铁律保留原样（handbook/02-接单总台账/README.md 沿革 2026-10-11）
DEAD_OK = re.compile(r'(^|/)pr/(pi|opencode)/')
BLOCKING = ('LINK', 'TABLE', 'COUNT')
LINK = re.compile(r'\]\(([^)\s]+)\)')
FENCE = re.compile(r'^(```|~~~)')

def md_files():
    for d, _, fs in os.walk(ROOT):
        for f in fs:
            p = os.path.join(d, f)
            if f.endswith('.md') and not any(s in p + '/' for s in SKIP):
                yield p

def strip_fences(text):
    out, inside = [], False
    for line in text.split('\n'):
        if FENCE.match(line.strip()):
            inside = not inside
            out.append('')
        else:
            out.append('' if inside else line)
    return out

def cells(row):
    # 统计未转义的 | 分隔的单元格数（行内代码里的 | 不计）
    row = re.sub(r'`[^`]*`', '', row).strip()
    return len(re.split(r'(?<!\\)\|', row.strip('|')))

def check(p, errs):
    rel = os.path.relpath(p, ROOT)
    text = open(p, encoding='utf-8', errors='ignore').read()
    lines = strip_fences(text)

    # LINK：只校验落在 docs 内的相对链接；指向 clone 侧（../../<repo>/）的链接在 docs 外，不在此验证。
    # 行内代码跨度里的链接语法是示例不是真链接（同 cells() 口径剥离）；含 scheme（://）的目标本地不可验，跳过。
    for i, raw in enumerate(lines, 1):
        line = re.sub(r'`[^`]*`', '', raw)
        for m in LINK.finditer(line):
            u = m.group(1)
            if '://' in u or u.startswith(('mailto:', '#')) or DEAD_OK.search(u):
                continue
            tgt = os.path.abspath(os.path.join(os.path.dirname(p), urllib.parse.unquote(u.split('#')[0])))
            if tgt.startswith(ROOT + os.sep) and not os.path.exists(tgt):
                errs.append(('LINK', f'{rel}:{i} -> {u}'))

    # TABLE：表头列数必须等于分隔行列数（不等时 GFM 不渲染为表格）
    for i in range(1, len(lines)):
        if re.match(r'^\s*\|?\s*:?-{3,}', lines[i]) and lines[i - 1].lstrip().startswith('|'):
            h, s = cells(lines[i - 1]), cells(lines[i])
            if h != s:
                errs.append(('TABLE', f'{rel}:{i} 表头 {h} 列 ≠ 分隔行 {s} 列'))

    # SIZE：规则类（handbook/，台账除外）30KB，其余 45KB
    size = len(text.encode())
    lim = 30_000 if '/handbook/' in p and '02-接单总台账' not in p else 45_000
    if size > lim:
        errs.append(('SIZE', f'{rel} {size // 1000}KB > {lim // 1000}KB'))

    # ORDER：在途快照按节标题日期与 rN 轮次倒序
    if p.endswith('在途快照.md'):
        keys = []
        for h in re.findall(r'^## .*$', text, re.M):
            d, r = re.search(r'(\d{4}-\d{2}-\d{2})', h), re.search(r'\br(\d+)\b', h)
            if d:
                keys.append((d.group(1), int(r.group(1)) if r else 0, h[3:50]))
        for a, b in zip(keys, keys[1:]):
            if a[:2] < b[:2]:
                errs.append(('ORDER', f'{rel}: 「{a[2]}」排在更新的「{b[2]}」之前'))

    # COUNT：各仓必须有与实际一致的生成块；README 只作索引，不参与统计。
    if '02-接单总台账' in p and not p.endswith('README.md'):
        block = re.search(rf'{re.escape(ledger_stats.BEGIN)}.*?{re.escape(ledger_stats.END)}', text, re.S)
        if not block:
            errs.append(('COUNT', f'{rel} 缺少 stats 生成块（python3 scripts/ledger_stats.py --apply 补齐）'))
        elif block.group(0) != ledger_stats.block_file(text):
            errs.append(('COUNT', f'{rel} stats 生成块与实际不符（python3 scripts/ledger_stats.py --apply 刷新）'))

def main():
    errs = []
    for p in sorted(md_files()):
        check(p, errs)
    def level(e):
        return 'ERROR' if e[0] in BLOCKING else 'WARN '
    for e in sorted(errs, key=lambda e: (level(e).strip() != 'ERROR', e)):
        print(f'{level(e)} {e[0]:5} {e[1]}')
    summary = {}
    for kind, *_ in errs:
        summary[kind] = summary.get(kind, 0) + 1
    blocking = sum(1 for e in errs if level(e) == 'ERROR')
    print(f'\n汇总: {summary or "全部通过"}；阻断 {blocking}')
    return 1 if blocking else 0

if __name__ == '__main__':
    sys.exit(main())
