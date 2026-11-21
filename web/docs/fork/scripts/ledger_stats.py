#!/usr/bin/env python3
"""接单总台账派生数据脚本（只读标准库）。

用法（docs 根执行）：
  python3 scripts/ledger_stats.py            # dry-run：打印统计、待移动终态行与生成块计划，不落盘
  python3 scripts/ledger_stats.py --apply    # 落盘：终态行归位 + 生成/更新 stats 生成块
  python3 scripts/ledger_stats.py --check    # 校验：各仓生成块齐全且与实际统计逐字一致，否则退出 1

规则（handbook/02 README 铁律 + handbook/10 §6）：
  - 已有表格行逐字不改，只允许移动位置；全局号不动。
  - 活账中状态列首词为 closed / merged / 让坑 / 放弃 / 被取代 的行移入同文件「终态归档」，按全局号排序。
  - 头部手写计数句保留原文，行尾追加口径注记；其后插入 <!-- stats:begin/end --> 生成块。
  - README 只作索引，不读写汇总计数。
"""
import os, re, sys

DOCS = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
LEDGER = os.path.join(DOCS, 'handbook', '02-接单总台账')
TERMINAL = ('closed', 'merged', '让坑', '放弃', '被取代')
BEGIN, END = '<!-- stats:begin ', '<!-- stats:end -->'
ROW = re.compile(r'^\|\s*(\d+)\s*\|')

def data_rows(lines):
    return [l for l in lines if ROW.match(l)]

def status_first_word(row):
    body = re.sub(r'`[^`]*`', '', row).strip().strip('|')
    cells = re.split(r'(?<!\\)\|', body)
    return (cells[4].strip().lstrip('*').lower() if len(cells) > 4 else '')

def is_terminal(row):
    w = status_first_word(row)
    # (?![A-Za-z]) 防英文误扩展（closedx 不算 closed）；后随中文/标点/加粗闭合均算命中
    return bool(re.match(r'^(closed|merged|让坑|放弃|被取代)(?![A-Za-z])', w))

def split_sections(text):
    """按顶级 ## 切节；返回 (前导, [(标题, 节行)], 尾注)。节行含标题行。"""
    lines = text.split('\n')
    heads = [i for i, l in enumerate(lines) if l.startswith('## ')]
    if not heads:
        return lines, [], []
    pre = lines[:heads[0]]
    secs = [(lines[h].strip('# \n'), lines[h:heads[i+1] if i+1 < len(heads) else len(lines)])
            for i, h in enumerate(heads)]
    return pre, secs, []

def stats_of(text):
    """返回 (活账行 list, 归档行 list, 活账行数, 归档行数, 活账号区间, 归档号区间)。"""
    _, secs, _ = split_sections(text)
    live, done = [], []
    for title, body in secs:
        rows = data_rows(body)
        if title == '活账':
            live = rows
        elif title == '终态归档':
            done = rows
    rng = lambda rs: (f"{min(int(ROW.match(r).group(1)) for r in rs)}–{max(int(ROW.match(r).group(1)) for r in rs)}" if rs else '无')
    return live, done, len(live), len(done), rng(live), rng(done)

def block_file(text):
    _, _, n_live, n_done, r_live, r_done = stats_of(text)
    return (f'{BEGIN}（scripts/ledger_stats.py 生成，勿手改；python3 scripts/ledger_stats.py --check 校验）\n'
            f'活账 {n_live} 行（全局号 {r_live}）／终态归档 {n_done} 行（全局号 {r_done}）\n{END}')

def repo_files():
    return [os.path.join(LEDGER, f) for f in sorted(os.listdir(LEDGER))
            if f.endswith('.md') and f != 'README.md']

def insert_after(text, anchor_re, block):
    """在首个匹配 anchor_re 的整行之后插入生成块。"""
    lines = text.split('\n')
    for i, l in enumerate(lines):
        if re.search(anchor_re, l):
            return '\n'.join(lines[:i+1] + [block] + lines[i+1:])
    raise ValueError('未找到生成块插入锚点')

def migrate_text(text, path):
    """终态行归位；返回 (新文本, 移动行 [(号, 状态首词, 行)])。内存断言不过则抛异常。"""
    pre, secs, _ = split_sections(text)
    moved, out_secs = [], []
    for title, body in secs:
        if title == '活账':
            keep, mv = [], []
            for l in body:
                (mv if is_terminal(l) else keep).append(l)
            moved = mv
            out_secs.append((title, keep))
        elif title == '终态归档':
            existing = [l for l in body if ROW.match(l)]
            segs = [i for i, l in enumerate(body) if ROW.match(l)]
            # 分段（被空行隔开）且本轮有行移入 → 拒绝自动化；无移入则原样保留
            contiguous = all(b - a == 1 for a, b in zip(segs, segs[1:]))
            if not contiguous:
                assert not moved, f'{path}: 终态归档有多个数据段且本轮有终态行移入，需人工归位'
                out_secs.append((title, body))
            else:
                merged = sorted(existing + moved, key=lambda r: int(ROW.match(r).group(1)))
                new_body = body[:segs[0]] + merged + body[segs[-1] + 1:]
                out_secs.append((title, new_body))
        else:
            out_secs.append((title, body))
    if moved:
        # 重组：前导 + 各节（活账缺行、归档插行）
        new_lines = list(pre)
        for title, body in out_secs:
            new_lines.extend(body)
        new_text = '\n'.join(new_lines)
        # 行集守恒断言：活账+归档的数据行多重集移动前后完全相等，且活账不再含终态行
        l0, d0, *_ = stats_of(text)
        l1, d1, *_ = stats_of(new_text)
        assert sorted(l0 + d0) == sorted(l1 + d1), f'{path}: 移动前后行集不相等'
        assert not [l for l in l1 if is_terminal(l)], f'{path}: 活账仍含终态行'
        return new_text, [(ROW.match(m).group(1), status_first_word(m), m) for m in moved]
    return text, []

def process(skip=()):
    problems, moved_all, changed = [], [], []
    files = [f for f in repo_files() if os.path.basename(f) not in skip]
    for f in files:
        text = open(f, encoding='utf-8').read()
        base = os.path.basename(f)
        new_text, moved = migrate_text(text, base)
        if moved:
            moved_all += [(base,) + m for m in moved]
        # 计数句注记 + 生成块
        claim = re.search(r'^.*活账\s*\d+\s*行\s*/\s*终态归档\s*\d+\s*行.*$', new_text, re.M)
        if claim and '（历史口径，以下方生成块为准）' not in claim.group(0):
            new_text = new_text.replace(claim.group(0), claim.group(0) + '（历史口径，以下方生成块为准）', 1)
        new_text = re.sub(rf'{re.escape(BEGIN)}.*?{re.escape(END)}\n?', '', new_text, flags=re.S)
        new_text = insert_after(new_text, r'（历史口径，以下方生成块为准）|^.*活账\s*\d+\s*行\s*/\s*终态归档.*$', block_file(new_text))
        if new_text != text:
            changed.append((f, new_text))
    return changed, moved_all

def main():
    apply = '--apply' in sys.argv
    check = '--check' in sys.argv
    skip = []
    if '--skip' in sys.argv:
        skip = sys.argv[sys.argv.index('--skip') + 1].split(',')
    changed, moved_all = process(skip=skip)
    if check:
        bad = checked = 0
        for f in repo_files():
            text = open(f, encoding='utf-8').read()
            actual = re.search(rf'{re.escape(BEGIN)}.*?{re.escape(END)}', text, re.S)
            if not actual:
                print(f'CHECK FAIL {os.path.basename(f)}: 缺少 stats 生成块（python3 scripts/ledger_stats.py --apply 补齐）')
                bad += 1
                continue
            checked += 1
            want = block_file(text)
            if actual.group(0) != want:
                print(f'CHECK FAIL {os.path.basename(f)}: 生成块与实际不符')
                bad += 1
        print(f'--check：{checked} 个生成块，{bad} 个失配')
        sys.exit(1 if bad else 0)
    for repo, num, status, row in moved_all:
        print(f'待移动 {repo} #{num} [{status}] {row[:60]}…')
    print(f'\n待移动 {len(moved_all)} 行；待更新生成块 {len(changed)} 个文件' + ('' if apply else '（dry-run，未落盘；--apply 落盘）'))
    if apply:
        for f, new_text in changed:
            open(f, 'w', encoding='utf-8').write(new_text)
        print(f'已落盘 {len(changed)} 个文件（行集守恒断言已过；随后用 --check 复验）')

if __name__ == '__main__':
    main()
