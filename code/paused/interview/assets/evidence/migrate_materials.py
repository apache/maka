"""面试材料迁移：只处理本目录；不删除原始文件，不修改目录外工作树。"""
from pathlib import Path
import argparse, hashlib, json, os, re, subprocess, zipfile
from urllib.parse import unquote

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / 'assets/evidence'
INDEX = DATA / '00-迁移前完整盘点.json'
MANIFEST = DATA / '03-迁移映射.json'

def safe(rel):
    p = (ROOT / rel).resolve()
    if not p.is_relative_to(ROOT) or p == ROOT:
        raise ValueError(f'路径越界: {rel}')
    return p

def write(rel, text):
    p = safe(rel); p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text, encoding='utf-8', newline='\n')

def git(*args):
    return subprocess.run(['git', '-c', 'core.quotepath=false', '-C', str(ROOT), *args], capture_output=True)

def plan():
    rows = json.loads(INDEX.read_text(encoding='utf-8'))
    result = []
    for row in rows:
        old = row['path']; name = Path(old).name; top = old.split('/')[0]
        if old in ('.gitignore', '2026-10-面试宝典-AI方向重构与归档方案.md'):
            continue
        status, reason, replacement = 'superseded', '合并重写，旧正文保留供对照', 'README.md'
        if row['tool_state']:
            new = 'archive/raw-evidence/tool-state/' + old
            status, reason, replacement = 'raw-evidence', '工具状态，不进入知识导航', ''
        elif name.endswith('.json'):
            new = 'assets/evidence/' + name
            status, reason, replacement = 'raw-evidence', '原始评审证据，逐字节保留', '00-事实与简历/05-项目归属与量化证据.md'
        elif name.endswith('.xlsx'):
            new = 'assets/spreadsheets/' + name
            status, reason = 'raw-evidence', '原始工作簿，逐字节保留'
        elif name.lower().endswith('.jpg'):
            new = 'assets/screenshots/' + name
            status, reason = 'raw-evidence', '原始截图，逐字节保留；含私人沟通，非投递附件'
        elif name.endswith('.zip'):
            new = 'archive/历史简历/raw/' + name
            status, reason = 'historical', '保留原始简历包与旧模板'
        elif old == '05-面试话术/06-实战项目经验.md' or old == '05-面试话术/08-个人项目实战汇总.md' or (top == '04-项目亮点' and name[:2] in ('01','02','03','04','05')) or old == '07-个人总结/01-PromptFlow-项目亮点总结.md':
            new = 'archive/待核验资料/' + old
            status, reason, replacement = 'needs-verification', '混合项目归属或无依据数字；仅提炼通用知识，个人成果暂停引用', '00-事实与简历/06-待核验清单.md'
        elif name.startswith('19-李豪') or old == '07-AI智能体学习地图/02-同事智能体代码精读素材.md':
            new = 'archive/协作归属参考/' + name
            status, reason, replacement = 'reference-only', '同事资料仅用于区分归属与学习', '00-事实与简历/05-项目归属与量化证据.md'
        elif top == '09-项目治理':
            if name.startswith('希音'):
                new = 'archive/raw-evidence/' + name
                status, reason, replacement = 'reference-only', '保留带日期和统计口径的项目证据', '02-传统前端基本盘/00-希音与德奥项目总览.md'
            else:
                new = 'archive/项目治理-202606/' + name
                status, reason, replacement = 'historical', '2026年6月治理快照，提炼方法而非复制项目规模', '01-AI项目与Agent工程/09-项目资产治理案例.md'
        elif top == '08-求职记录':
            new = 'archive/历史求职记录/2025/' + name
            status, reason, replacement = 'historical', '旧投递记录及模板；新记录从空表开始', '05-十月求职执行/02-投递记录.md'
        elif old == '07-个人总结/05-外包公司.md':
            new = 'archive/历史求职记录/私密/' + name
            status, reason, replacement = 'historical', '私人记录与历史情绪，不进入面试表达', '04-表达与模拟/04-HR与反问.md'
        elif old == '07-个人总结/10-互联网就业现状分析.md':
            new = 'archive/历史求职记录/' + name
            status, reason = 'historical', '历史市场判断不作为2026行情'
        elif top == '06-个人材料' and name[:2] in ('01','04','11','13','14','16') and 'clife' not in name:
            new = 'archive/历史简历/' + name
            replacement = '00-事实与简历/01-关天豪-AI应用工程师-主简历.md'
        elif top == '06-个人材料' and (name[:2] in ('18','20','21') or 'clife' in name):
            new = 'archive/raw-evidence/' + name
            status, reason, replacement = 'reference-only', '历史职责与决策证据，不回写为新事实', '00-事实与简历/05-项目归属与量化证据.md'
        elif top == '05-面试话术' or (top == '06-个人材料' and name[:2] in ('02','03','07','08','09','22','23')):
            new = 'archive/历史话术/' + old
            replacement = '04-表达与模拟/01-项目讲述库.md'
        else:
            new = 'archive/历史复习资料/' + (old if '/' in old else '迁移前-' + old)
        safe(old); safe(new)
        result.append(dict(old=old, new=new, status=status, reason=reason, replacement=replacement, sha256=row['sha256'], method='pending'))
    assert len({x['new'].casefold() for x in result}) == len(result)
    write(MANIFEST.relative_to(ROOT), json.dumps(result, ensure_ascii=False, indent=2))
    print(f'PLAN: {len(result)} moves; all destinations confined')

def move():
    rows = json.loads(MANIFEST.read_text(encoding='utf-8'))
    for x in rows:
        src, dst = safe(x['old']), safe(x['new'])
        if x['method'] != 'pending':
            assert dst.is_file(); continue
        assert src.is_file() and not dst.exists(), x['old']
        assert hashlib.sha256(src.read_bytes()).hexdigest() == x['sha256'], '源文件已发生新变化，停止'
        dst.parent.mkdir(parents=True, exist_ok=True)
        tracked = git('ls-files', '--error-unmatch', '--', x['old']).returncode == 0
        if tracked:
            run = git('mv', '--', x['old'], x['new'])
            if run.returncode:
                raise RuntimeError(run.stderr.decode('utf-8', errors='replace'))
            x['method'] = 'git mv'
        else:
            src.rename(dst); x['method'] = 'native rename (untracked or ignored)'
        assert hashlib.sha256(dst.read_bytes()).hexdigest() == x['sha256']
        write(MANIFEST.relative_to(ROOT), json.dumps(rows, ensure_ascii=False, indent=2))
    print('MOVED:', len(rows), 'git mv:', sum(x['method']=='git mv' for x in rows))

def main():
    p=argparse.ArgumentParser();p.add_argument('phase',choices=['plan','move']);a=p.parse_args()
    {'plan':plan,'move':move}[a.phase]()

if __name__=='__main__':main()
