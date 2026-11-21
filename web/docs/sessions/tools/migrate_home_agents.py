import difflib, hashlib, json, os, re, shutil, stat, subprocess, sys, zipfile
from pathlib import Path

# 迁移 Windows home 下各 Coding Agent 的会话数据到 guahub/sessions。
# 状态机与 deliverable 沿用 raw/cursor/migration-20261026-120731/migrate_cursor.py：
# baseline -> archive -> apply -> verify -> rollback-test / rollback。
# category=archive 的组打包进 RUN（会话记录，值得保留，DEFLATED）；category=cache 的组打包进
# _trash（可再生，等待清理；ZIP_STORED 纯复制，zip 只为保证可回滚）。
# usage: python migrate_home_agents.py <agent> <mode> [run-name]
#   run-name 可选，操作指定的历史 migration 目录（同 agent 多批次时用，ROLLBACK.sh 内已带上）。

ROOT = Path(r'E:\cc\guahub\sessions')
HOME = Path(r'C:\Users\802165')
ROAM = HOME / 'AppData' / 'Roaming'
LOCAL = HOME / 'AppData' / 'Local'

# Electron 桌面端的标准缓存目录集合（不存在的自动跳过）；全部可再生
ELECTRON_CACHE_DIRS = ('Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache',
    'Crashpad', 'sentry', 'CachedData', 'CachedExtensionVSIXs', 'CachedProfilesData',
    'SharedClientCache', 'v8-code-cache', 'plugin-logo-cache', 'link-favicon-cache', 'link-preview-cache')


def electron(slug, root, logs=True):
    cfg = [(f'{slug}-{n}', root / n, '**/*', True, 'cache') for n in ELECTRON_CACHE_DIRS]
    if logs:
        cfg.append((f'{slug}-logs', root / 'logs', '**/*', True, 'archive'))
    return cfg


AGENTS = {
    'claude': dict(
        idle=r'^claude($|-)',
        protect=[HOME / '.claude/settings.json'],
        config=[
            ('projects',        HOME / '.claude/projects',        '**/*', True,  'archive'),
            ('file-history',    HOME / '.claude/file-history',    '**/*', True,  'archive'),
            ('shell-snapshots', HOME / '.claude/shell-snapshots', '**/*', True,  'cache'),
            ('telemetry',       HOME / '.claude/telemetry',       '**/*', True,  'cache'),
            ('cache',           HOME / '.claude/cache',           '**/*', True,  'cache'),
        ],
    ),
    'kimi': dict(
        idle=r'^kimi($|-)',
        protect=[HOME / '.kimi/kimi.json', HOME / '.kimi/config.toml'],
        config=[
            ('sessions', HOME / '.kimi/sessions', '**/*', True, 'archive'),
        ],
    ),
    'gemini': dict(
        idle=r'^gemini($|-)',
        protect=[HOME / '.gemini/settings.json'],
        config=[
            ('tmp',     HOME / '.gemini/tmp',     '**/*', True, 'archive'),
            ('history', HOME / '.gemini/history', '**/*', True, 'archive'),
        ],
    ),
    # codex 的 .codex/sqlite/（thread/memories/goals 活状态库）原地保留，不入 config；
    # codex 主进程/伴生服务运行时 idle 守卫会拒绝执行。
    'codex': dict(
        idle=r'^codex($|-)',
        protect=[HOME / '.codex/config.toml'],
        config=[
            ('sessions',             HOME / '.codex/sessions',             '**/*', True,  'archive'),
            ('archived-sessions',    HOME / '.codex/archived_sessions',    '**/*', True,  'archive'),
            ('attachments',          HOME / '.codex/attachments',          '**/*', True,  'archive'),
            ('browser-sessions',     HOME / '.codex/browser/sessions',     '**/*', True,  'archive'),
            ('log',                  HOME / '.codex/log',                  '**/*', True,  'archive'),
            ('history-jsonl',        HOME / '.codex', 'history.jsonl',                    False, 'archive'),
            ('session-index',        HOME / '.codex', 'session_index.jsonl',              False, 'archive'),
            ('transcription-history', HOME / '.codex', 'transcription-history.jsonl',      False, 'archive'),
            ('external-agent-imports', HOME / '.codex', 'external_agent_session_imports.json', False, 'archive'),
            ('cache',                HOME / '.codex/cache',                '**/*', True,  'cache'),
            # 2026-10-26 第二批：.codex 深处的大体积缓存与历史库（share/ 是用户自存的微信工具数据，勿动）
            ('thread-history',       HOME / '.codex', 'thread_history_1.sqlite*', False, 'archive'),
            ('app-logs-db',          HOME / '.codex', 'logs_2.sqlite*', False, 'archive'),
            ('plugins',              HOME / '.codex/plugins',              '**/*', True,  'cache'),
            ('sandbox',              HOME / '.codex/.sandbox',             '**/*', True,  'cache'),
            ('sandbox-bin',          HOME / '.codex/.sandbox-bin',         '**/*', True,  'cache'),
            ('tmp',                  HOME / '.codex/.tmp',                 '**/*', True,  'cache'),
            ('tmp2',                 HOME / '.codex/tmp',                  '**/*', True,  'cache'),
            ('ambient-suggestions',  HOME / '.codex/ambient-suggestions',  '**/*', True,  'cache'),
            ('computer-use-turn-ended', HOME / '.codex/computer-use-turn-ended', '**/*', True, 'cache'),
            ('context-mode',         HOME / '.codex/context-mode',         '**/*', True,  'cache'),
            ('visualizations',       HOME / '.codex/visualizations',       '**/*', True,  'cache'),
            ('backups',              HOME / '.codex/backups',              '**/*', True,  'cache'),
            ('config-backup',        HOME / '.codex/config-backup-20260904', '**/*', True, 'cache'),
            ('vendor-imports',       HOME / '.codex/vendor_imports',       '**/*', True,  'cache'),
            ('process-manager',      HOME / '.codex/process_manager',      '**/*', True,  'cache'),
        ],
    ),
    # ===== 2026-10-26 第二批排查新增 =====
    'factory': dict(
        idle=r'^factory$|^droid',
        protect=[HOME / '.factory/settings.json'],
        config=[
            ('sessions',  HOME / '.factory/sessions',  '**/*', True, 'archive'),
            ('snapshots', HOME / '.factory/snapshots', '**/*', True, 'archive'),
            ('artifacts', HOME / '.factory/artifacts', '**/*', True, 'archive'),
            ('logs',      HOME / '.factory/logs',      '**/*', True, 'archive'),
            ('cache',     HOME / '.factory/cache',     '**/*', True, 'cache'),
            ('temp',      HOME / '.factory/temp',      '**/*', True, 'cache'),
            ('telemetry', HOME / '.factory/telemetry', '**/*', True, 'cache'),
        ],
    ),
    'grok': dict(
        idle=r'^grok',
        protect=[HOME / '.grok/config.toml'],
        config=[
            ('sessions',  HOME / '.grok/sessions',  '**/*', True, 'archive'),
            ('logs',      HOME / '.grok/logs',      '**/*', True, 'archive'),
            ('downloads', HOME / '.grok/downloads', '**/*', True, 'cache'),
            ('memtrace',  HOME / '.grok/memtrace',  '**/*', True, 'cache'),
        ],
    ),
    'kimi-code': dict(
        idle=r'^kimi',
        protect=[HOME / '.kimi-code/config.toml'],
        config=[
            ('sessions',      HOME / '.kimi-code/sessions', '**/*', True, 'archive'),
            ('logs',          HOME / '.kimi-code/logs',     '**/*', True, 'archive'),
            ('session-index', HOME / '.kimi-code', 'session_index.jsonl', False, 'archive'),
        ],
    ),
    'kimi': dict(
        idle=r'^kimi',
        protect=[HOME / '.kimi/config.toml', HOME / '.kimi/kimi.json'],
        config=[
            ('logs',      HOME / '.kimi/logs',      '**/*', True, 'archive'),
            ('plans',     HOME / '.kimi/plans',     '**/*', True, 'archive'),
            ('telemetry', HOME / '.kimi/telemetry', '**/*', True, 'cache'),
        ],
    ),
    'kimi-webbridge': dict(
        idle=r'^kimi',
        protect=[],
        config=[('logs', HOME / '.kimi-webbridge/logs', '**/*', True, 'archive')],
    ),
    'deepseek': dict(
        idle=r'^deepseek',
        protect=[HOME / '.deepseek/config.toml'],
        config=[
            ('sessions',         HOME / '.deepseek/sessions', '**/*', True, 'archive'),
            ('snapshots',        HOME / '.deepseek/snapshots', '**/*', True, 'archive'),
            ('audit',            HOME / '.deepseek', 'audit.log', False, 'archive'),
            ('composer-history', HOME / '.deepseek', 'composer_history.txt', False, 'archive'),
        ],
    ),
    'dsh': dict(
        idle=r'^dsh',
        protect=[],
        config=[
            ('sessions',    HOME / '.dsh/sessions',    '**/*', True, 'archive'),
            ('attachments', HOME / '.dsh/attachments', '**/*', True, 'archive'),
        ],
    ),
    'copilot': dict(
        idle=r'^copilot$',
        protect=[HOME / '.copilot/config.json'],
        config=[('logs', HOME / '.copilot/logs', '**/*', True, 'archive')],
    ),
    'lody': dict(
        idle=r'^lody',
        protect=[],
        config=[('logs', HOME / '.lody/logs', '**/*', True, 'archive')],
    ),
    'cc-switch': dict(
        idle=r'^cc-switch',
        protect=[HOME / '.cc-switch/settings.json'],
        config=[
            ('logs',    HOME / '.cc-switch/logs',    '**/*', True, 'archive'),
            ('backups', HOME / '.cc-switch/backups', '**/*', True, 'cache'),
        ],
    ),
    'amp': dict(
        idle=r'^amp$',
        protect=[],
        config=[
            ('file-changes', HOME / '.amp/file-changes', '**/*', True, 'archive'),
            ('threads',      HOME / '.local/share/amp/threads', '**/*', True, 'archive'),
            ('history',      HOME / '.local/share/amp', 'history.jsonl', False, 'archive'),
            ('session',      HOME / '.local/share/amp', 'session.json', False, 'archive'),
        ],
    ),
    'opencode': dict(
        idle=r'^opencode',
        protect=[HOME / '.config/opencode/opencode.json'],
        config=[
            ('snapshot',     HOME / '.local/share/opencode/snapshot', '**/*', True, 'archive'),
            ('log',          HOME / '.local/share/opencode/log', '**/*', True, 'archive'),
            ('node-modules', HOME / '.config/opencode/node_modules', '**/*', True, 'cache'),
            ('cache',        HOME / '.cache/opencode', '**/*', True, 'cache'),
            # .local/share/opencode/opencode.db 是 opencode 的活会话库，原地保留
        ],
    ),
    'workbuddy': dict(
        idle=r'^workbuddy|genie',
        protect=[HOME / '.workbuddy/settings.json'],
        config=[
            ('logs',              HOME / '.workbuddy/logs', '**/*', True, 'archive'),
            ('audit-log',         HOME / '.workbuddy/audit-log', '**/*', True, 'archive'),
            # binaries/ 内含 PortableGit 的 junction（versions/1.3.0），reparse 守卫拒绝打包，原地保留
            ('plugins',           HOME / '.workbuddy/plugins', '**/*', True, 'cache'),
            ('app',               HOME / '.workbuddy/app', '**/*', True, 'cache'),
            ('cache',             HOME / '.workbuddy/cache', '**/*', True, 'cache'),
            ('pending-telemetry', HOME / '.workbuddy/pending-telemetry', '**/*', True, 'cache'),
        ],
    ),
    'workbuddy-ai': dict(
        idle=r'^workbuddy|genie',
        protect=[HOME / '.workbuddy-ai/settings.json'],
        config=[
            ('logs',                   HOME / '.workbuddy-ai/logs', '**/*', True, 'archive'),
            ('sessions',               HOME / '.workbuddy-ai/sessions', '**/*', True, 'archive'),
            ('shell-snapshots',        HOME / '.workbuddy-ai/shell-snapshots', '**/*', True, 'archive'),
            ('traces',                 HOME / '.workbuddy-ai/traces', '**/*', True, 'archive'),
            ('audit-log',              HOME / '.workbuddy-ai/audit-log', '**/*', True, 'archive'),
            # binaries/ 内含 PortableGit 的 junction，原地保留
            ('plugins',                HOME / '.workbuddy-ai/plugins', '**/*', True, 'cache'),
            ('app',                    HOME / '.workbuddy-ai/app', '**/*', True, 'cache'),
            ('connectors-marketplace', HOME / '.workbuddy-ai/connectors-marketplace', '**/*', True, 'cache'),
            ('cache',                  HOME / '.workbuddy-ai/cache', '**/*', True, 'cache'),
            ('pending-telemetry',      HOME / '.workbuddy-ai/pending-telemetry', '**/*', True, 'cache'),
        ],
    ),
    'codegeex': dict(
        idle=r'^codegeex',
        protect=[],
        config=[
            ('mamba', HOME / '.codegeex/mamba', '**/*', True, 'cache'),
            ('agent', HOME / '.codegeex/agent', '**/*', True, 'cache'),
        ],
    ),
    'mimo2codex': dict(
        idle=r'^mimo',
        protect=[],
        config=[('cache', HOME / '.mimo2codex/cache', '**/*', True, 'cache')],
    ),
    'qoder': dict(
        idle=r'^qoder',
        protect=[HOME / '.qoder/settings.json'],
        config=[
            ('extensions', HOME / '.qoder/extensions', '**/*', True, 'cache'),
            ('plugins',    HOME / '.qoder/plugins',    '**/*', True, 'cache'),
            ('canvas',     HOME / '.qoder/canvas',     '**/*', True, 'archive'),
            ('cache',      HOME / '.qoder/cache',      '**/*', True, 'cache'),
        ],
    ),
    'qoder-cn': dict(
        idle=r'^qoder',
        protect=[HOME / '.qoder-cn/settings.json'],
        config=[
            ('extensions', HOME / '.qoder-cn/extensions', '**/*', True, 'cache'),
            ('plugins',    HOME / '.qoder-cn/plugins',    '**/*', True, 'cache'),
            ('canvas',     HOME / '.qoder-cn/canvas',     '**/*', True, 'archive'),
        ],
    ),
    'trae-cn': dict(
        idle=r'^trae',
        protect=[HOME / '.trae-cn/argv.json'],
        config=[
            ('extensions', HOME / '.trae-cn/extensions', '**/*', True, 'cache'),
            ('builtin',    HOME / '.trae-cn/builtin',    '**/*', True, 'cache'),
        ],
    ),
    'codebuddy': dict(
        idle=r'^codebuddy',
        protect=[HOME / '.codebuddy/settings.json'],
        config=[
            ('plugins',            HOME / '.codebuddy/plugins',            '**/*', True, 'cache'),
            ('skills-marketplace', HOME / '.codebuddy/skills-marketplace', '**/*', True, 'cache'),
            ('logs',               HOME / '.codebuddy/logs',               '**/*', True, 'archive'),
        ],
    ),
    'codebuddycn': dict(
        idle=r'^codebuddy',
        protect=[],
        config=[('extensions', HOME / '.codebuddycn/extensions', '**/*', True, 'cache')],
    ),
    'lingma': dict(
        idle=r'^lingma',
        protect=[],
        config=[('extensions', HOME / '.lingma/extensions', '**/*', True, 'cache')],
    ),
    'kiro': dict(
        idle=r'^kiro',
        protect=[],
        config=[('extensions', HOME / '.kiro/extensions', '**/*', True, 'cache')],
    ),
    'antigravity': dict(
        idle=r'^antigravity|cockpit',
        protect=[HOME / '.antigravity/argv.json'],
        config=[('extensions', HOME / '.antigravity/extensions', '**/*', True, 'cache')],
    ),
    'antigravity-ide': dict(
        idle=r'^antigravity',
        protect=[],
        config=[('extensions', HOME / '.antigravity-ide/extensions', '**/*', True, 'cache')],
    ),
    'antigravity-cockpit': dict(
        idle=r'^antigravity|cockpit',
        protect=[HOME / '.antigravity_cockpit/config.json'],
        config=[
            ('platform-packages', HOME / '.antigravity_cockpit/platform-packages', '**/*', True, 'cache'),
            ('cache',             HOME / '.antigravity_cockpit/cache', '**/*', True, 'cache'),
            ('backups',           HOME / '.antigravity_cockpit/backups', '**/*', True, 'cache'),
            ('logs',              HOME / '.antigravity_cockpit/logs', '**/*', True, 'archive'),
            # accounts*/ 与 account_store.sqlite 是账号凭证库，原地保留
        ],
    ),
    # Electron 桌面端应用档案（Roaming/Local）：仅动标准缓存目录与日志；web/Partitions/IndexedDB/
    # Local Storage/Network/Local State 等含登录态与用户数据，一律保留
    'ide-caches': dict(
        idle=r'trae|qoder|codebuddy|lingma|antigravity|kiro|kimi|grok|factory|droid|opencode|codepilot|waveterm|^wave$|^codex',
        protect=[],
        config=(
            electron('kimi-desktop', ROAM / 'kimi-desktop')
            + electron('qoder-desktop', ROAM / 'Qoder')
            + electron('lingma-desktop', ROAM / 'Lingma')
            + electron('grokbot-desktop', ROAM / 'Grok Bot')
            + electron('factory-desktop', ROAM / 'Factory')
            + electron('opencode-desktop', ROAM / 'ai.opencode.desktop')
            + electron('codepilot-desktop', ROAM / 'codepilot')
            + electron('wave-desktop', ROAM / 'Wave')
            + electron('antigravity-app', ROAM / 'Antigravity')
            + electron('antigravity-ide-app', ROAM / 'Antigravity IDE')
            + electron('codex-desktop', ROAM / 'Codex', logs=False)
            + [
                ('codex-desktop-local-logs',  LOCAL / 'Codex/Logs', '**/*', True, 'archive'),
                ('codex-desktop-runtimes',    LOCAL / 'OpenAI/Codex/runtimes', '**/*', True, 'cache'),
                ('cache-codex-runtimes',      HOME / '.cache/codex-runtimes', '**/*', True, 'cache'),
                ('cache-chrome-devtools-mcp', HOME / '.cache/chrome-devtools-mcp', '**/*', True, 'cache'),
            ]
        ),
    ),
}


def paths_for(agent):
    cfg = AGENTS[agent]
    mode = sys.argv[2]
    runs = sorted((ROOT / 'raw' / agent).glob('migration-*'))
    override = sys.argv[3] if len(sys.argv) > 3 else None
    if override:
        run = ROOT / 'raw' / agent / override
        assert run.is_dir(), 'run not found: ' + override
    elif mode == 'baseline':
        run = ROOT / 'raw' / agent / ('migration-' + runstamp())
    elif runs:
        run = runs[-1]
    else:
        raise AssertionError('no migration run for ' + agent + '; run baseline first')
    trash = ROOT / '_trash' / (agent + '-' + run.name)
    return run, trash, cfg


def runstamp():
    import datetime
    return datetime.datetime.now().strftime('%Y%m%d-%H%M%S')


def digest(stream):
    h = hashlib.sha256()
    for b in iter(lambda: stream.read(1024 * 1024), b''):
        h.update(b)
    return h.hexdigest()


def sha(p):
    with p.open('rb') as f:
        return digest(f)


def dump(p, obj):
    p.write_text(json.dumps(obj, ensure_ascii=False, indent=2) + '\n', encoding='utf8')


def load(run):
    return json.loads((run / 'MODIFIED_FILE.json').read_text('utf8'))


def save(run, m):
    man, orig = run / 'MODIFIED_FILE.json', run / 'ORIGINAL_FILE.json'
    dump(man, m)
    (run / 'DIFF_FILE.diff').write_text(''.join(difflib.unified_diff(
        orig.read_text('utf8').splitlines(True), man.read_text('utf8').splitlines(True),
        fromfile=str(orig), tofile=str(man))), encoding='utf8')


def idle(agent):
    cmd = "@(Get-Process -ErrorAction SilentlyContinue | Where-Object {$_.ProcessName -match '" + AGENTS[agent]['idle'] + "'}).Count"
    p = subprocess.run(['powershell.exe', '-NoProfile', '-Command', cmd], capture_output=True, text=True, check=True)
    if p.stdout.strip() != '0':
        raise RuntimeError('Process detected for ' + agent + '; source files retained')


def child(root, name):
    root, p = root.resolve(), root.resolve() / name
    if not p.resolve().is_relative_to(root) or ':' in name or '\\' in name:
        raise ValueError('Unexpected member: ' + name)
    for q in [p, *p.parents]:
        if q == root.parent:
            break
        if q.is_symlink() or q.is_junction():
            raise ValueError('Reparse point: ' + str(q))
    return p


def inventory(source, pattern, want_sha=True):
    # 返回 (files, dirs, reparse)：junction/symlink 条目不打包不删除，记入 reparse 交由 apply 跳过；
    # want_sha=False 时（可再生缓存档）只记 size/mtime，跳过逐文件哈希
    files, dirs, reparse = [], [], []
    if source.is_symlink() or source.is_junction():
        raise ValueError('Reparse root: ' + str(source))
    skipped_roots = set()
    for p in sorted(source.glob(pattern)):
        rel = p.relative_to(source).as_posix()
        if any(rel.startswith(r + '/') for r in skipped_roots):
            continue
        if p.is_symlink() or p.is_junction():
            skipped_roots.add(rel)
            reparse.append(rel)
            continue
        s = p.stat()
        if p.is_file():
            files.append(dict(path=rel, size=s.st_size, mtime_ns=s.st_mtime_ns,
                **({'sha256': sha(p)} if want_sha else {})))
        elif p.is_dir():
            dirs.append(rel)
    return files, dirs, reparse


def totals(m):
    files = [f for g in m['groups'] for f in g['files']]
    return len(files), sum(f['size'] for f in files)


def protected_ok(m):
    for name, expected in m['protected'].items():
        if sha(Path(name)) != expected:
            raise ValueError('Protected file changed: ' + name)


def verify_group(g):
    with zipfile.ZipFile(g['archive']) as z:
        expected = {f['path'] for f in g['files']} | {d + '/' for d in g['directories']}
        if len(z.infolist()) != len(expected) or set(z.namelist()) != expected:
            raise ValueError('Archive membership mismatch: ' + g['name'])
        for f in g['files']:
            if 'sha256' in f:
                with z.open(f['path']) as stream:
                    if digest(stream) != f['sha256']:
                        raise ValueError('Archive hash mismatch: ' + f['path'])
            elif z.getinfo(f['path']).file_size != f['size']:
                raise ValueError('Archive size mismatch: ' + f['path'])


def check_archives(m):
    for g in m['groups']:
        verify_group(g)


def baseline(agent, run, trash, cfg):
    idle(agent)
    if (run / 'MODIFIED_FILE.json').exists():
        raise ValueError('Baseline already exists')
    run.mkdir(parents=True, exist_ok=True)
    m = dict(state='source_present', groups=[], protected={})
    for name, source, pattern, remove_root, category in cfg['config']:
        if not source.is_dir():
            continue
        files, dirs, reparse = inventory(source, pattern, want_sha=(category == 'archive'))
        if not files and not dirs:
            continue
        parent = trash if category == 'cache' else run
        m['groups'].append(dict(name=name, source=str(source.resolve()), pattern=pattern,
            remove_root=remove_root, category=category, skipped=list(reparse),
            archive=str(parent / (name + '.zip')), files=files, directories=dirs))
    if not m['groups']:
        raise ValueError('Nothing to migrate')
    m['protected'] = {str(p): sha(p) for p in cfg['protect'] if p.is_file()}
    dump(run / 'ORIGINAL_FILE.json', m)
    save(run, m)
    (run / 'ROLLBACK.sh').write_text(
        '# 恢复本组迁移的全部源文件（对照 zip 逐文件校验 SHA-256）\n'
        'python "' + str(Path(__file__).resolve()) + '" ' + agent + ' rollback ' + run.name + '\n', encoding='utf8')
    n, size = totals(m)
    return f'BASELINE PASS groups={len(m["groups"])} files={n} bytes={size} protected={len(m["protected"])}'


def archive(run, trash):
    m = load(run)
    if m['state'] != 'source_present':
        raise ValueError('Expected source_present')
    for g in list(m['groups']):
        source, target = Path(g['source']), Path(g['archive'])
        if g['category'] == 'cache':
            # 缓存档不要求基线稳定（背后常有活服务在写）：以 archive 时刻实际内容为准刷新清单
            files, dirs, rep = inventory(source, g['pattern'], want_sha=False)
            if not files and not dirs:
                m['groups'].remove(g)
                continue
            g['files'], g['directories'], g['skipped'] = files, dirs, list(rep)
        else:
            files, dirs, _ = inventory(source, g['pattern'], want_sha=True)
            if (files, dirs) != (g['files'], g['directories']):
                raise ValueError('Source changed before archive: ' + g['name'])
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.exists():
            target.unlink()  # 上次 archive 中途失败的残留（本状态机下只可能是残留）
        method = zipfile.ZIP_STORED if g['category'] == 'cache' else zipfile.ZIP_DEFLATED
        with zipfile.ZipFile(target, 'x', method, compresslevel=6) as z:
            for d in g['directories']:
                z.write(child(source, d), d + '/')
            for f in g['files']:
                p = child(source, f['path'])
                try:
                    z.write(p, f['path'])
                except ValueError:  # 文件 mtime 早于 1980（zip 不支持），以 1980 兜底写入
                    info = zipfile.ZipInfo(f['path'], date_time=(1980, 1, 1, 0, 0, 0))
                    info.compress_type = method
                    info.external_attr = p.stat().st_file_attributes << 16 if hasattr(p, 'stat') else 0
                    with p.open('rb') as src, z.open(info, 'w') as dst:
                        shutil.copyfileobj(src, dst)
        verify_group(g)
    protected_ok(m)
    m['state'] = 'archived'
    save(run, m)
    n, size = totals(m)
    return f'ARCHIVE PASS zip_files={len(m["groups"])} files={n} bytes={size}'


def approved(run, g):
    expected = next(c for c in AGENTS[run.parent.name]['config'] if c[0] == g['name'])
    if Path(g['source']).resolve() != expected[1].resolve() or g['pattern'] != expected[2]:
        raise ValueError('Unapproved source path')
    return Path(g['source'])


def apply(agent, run):
    m = load(run)
    if m['state'] != 'archived':
        raise ValueError('Expected archived')
    idle(agent)
    check_archives(m)
    protected_ok(m)
    for g in m['groups']:
        root = approved(run, g)
        # 断点续删：仅记录档（哈希档）做新增/内容校验；缓存档背后常有活应用写文件，按清单路径直接删
        want = any('sha256' in f for f in g['files'])
        if want:
            cur_files, cur_dirs, _ = inventory(root, g['pattern'], want_sha=True)
            base_files = {f['path']: f for f in g['files']}
            extra = {f['path'] for f in cur_files} - set(base_files)
            if extra or set(cur_dirs) - set(g['directories']):
                raise ValueError('New source files appeared; no deletion started: ' + g['name'])
            for path, f in {f['path']: f for f in cur_files}.items():
                if f['sha256'] != base_files[path]['sha256']:
                    raise ValueError('Changed source retained: ' + str(root / path))
    for g in m['groups']:
        root = approved(run, g)
        for f in g['files']:
            p = child(root, f['path'])
            if not p.exists():
                continue
            if 'sha256' in f and sha(p) != f['sha256']:
                raise ValueError('Changed source retained: ' + str(p))
            try:
                p.unlink()
            except PermissionError:
                try:
                    os.chmod(p, stat.S_IWRITE)
                    p.unlink()
                except OSError:
                    g.setdefault('skipped', []).append(f['path'])
                    continue
        if g['remove_root']:
            for d in sorted(g['directories'], key=lambda d: (d.count('/'), len(d)), reverse=True):
                dpath = child(root, d)
                if dpath.is_dir():
                    try:
                        dpath.rmdir()
                    except OSError:
                        pass
            if root.is_dir():
                try:
                    root.rmdir()
                except OSError:
                    pass
    m['state'] = 'migrated'
    save(run, m)
    n, size = totals(m)
    skipped = sum(len(g.get('skipped', [])) for g in m['groups'])
    return f'APPLY PASS removed_files={n} removed_bytes={size} skipped={skipped}'


def verify(run):
    m = load(run)
    if m['state'] != 'migrated':
        raise ValueError('Expected migrated')
    check_archives(m)
    protected_ok(m)
    for g in m['groups']:
        root = approved(run, g)
        skipped = set(g.get('skipped', []))
        if g['remove_root'] and root.exists() and not skipped:
            raise ValueError('Source directory still exists: ' + str(root))
        if any(child(root, f['path']).exists() for f in g['files'] if f['path'] not in skipped):
            raise ValueError('Source file still exists: ' + str(root))
    n, size = totals(m)
    return f'MODIFIED PASS files={n} bytes={size} originals_absent=true protected_unchanged=true'


def restore(agent, run, trash, test=False):
    m = load(run)
    if m['state'] != 'migrated':
        raise ValueError('Expected migrated')
    if not test:
        idle(agent)
    check_archives(m)
    sandbox = ROOT / '_tmp' / run.name / ('rollback-copy-' + agent)
    if test and sandbox.exists():
        raise ValueError('Rollback test destination already exists')
    roots = [(g, sandbox / g['name'] if test else approved(run, g)) for g in m['groups']]
    for g, root in roots:
        for f in g['files']:
            p = child(root, f['path'])
            if p.exists() and (not p.is_file() or sha(p) != f['sha256']):
                raise ValueError('Rollback conflict; existing file retained: ' + str(p))
    for g, root in roots:
        root.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(g['archive']) as z:
            for d in g['directories']:
                child(root, d).mkdir(parents=True, exist_ok=True)
            for f in g['files']:
                p = child(root, f['path'])
                p.parent.mkdir(parents=True, exist_ok=True)
                if not p.exists():
                    with z.open(f['path']) as src, p.open('xb') as dst:
                        shutil.copyfileobj(src, dst)
                    os.utime(p, ns=(f['mtime_ns'], f['mtime_ns']))
                if p.stat().st_size != f['size'] or ('sha256' in f and sha(p) != f['sha256']):
                    raise ValueError('Restored hash mismatch: ' + str(p))
    if test:
        if not sandbox.resolve().is_relative_to((ROOT / '_tmp').resolve()):
            raise ValueError('Unexpected rollback sandbox')
        for p in sorted(sandbox.rglob('*'), key=lambda p: len(p.parts), reverse=True):
            p.unlink() if p.is_file() else p.rmdir()
        sandbox.rmdir()
    else:
        m['state'] = 'rolled_back'
        save(run, m)
    n, size = totals(m)
    label = 'ROLLBACK' if test else 'RESTORE'
    return f'{label} PASS restored_files={n} restored_bytes={size} hashes_match=true originals_untouched={str(test).lower()}'


def main():
    agent, mode = sys.argv[1], sys.argv[2]
    if agent not in AGENTS or mode not in ('baseline', 'archive', 'apply', 'verify', 'rollback-test', 'rollback'):
        raise ValueError('usage: migrate_home_agents.py <agent> <mode>')
    run, trash, cfg = paths_for(agent)
    evidence = run / 'VERIFICATION.txt'
    evidence.parent.mkdir(parents=True, exist_ok=True)
    command = subprocess.list2cmdline([sys.executable, str(Path(__file__).resolve()), agent, mode])
    man = run / 'MODIFIED_FILE.json'
    input_state = sha(man) if man.exists() else 'CONFIG: fixed ' + agent + ' source allowlist'
    try:
        result = {'baseline': lambda: baseline(agent, run, trash, cfg),
            'archive': lambda: archive(run, trash),
            'apply': lambda: apply(agent, run),
            'verify': lambda: verify(run),
            'rollback-test': lambda: restore(agent, run, trash, True),
            'rollback': lambda: restore(agent, run, trash)}[mode]()
        status = 0
    except Exception as e:
        result, status = type(e).__name__ + ': ' + str(e), 1
    with evidence.open('a', encoding='utf8') as f:
        f.write(f'COMMAND: {command}\nINPUT: {input_state}\nOUTPUT: {result}\nEXIT: {status}\n\n')
    print(result, flush=True)
    sys.exit(status)


if __name__ == '__main__':
    main()
