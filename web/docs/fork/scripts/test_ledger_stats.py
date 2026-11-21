#!/usr/bin/env python3
"""运行：python3 scripts/test_ledger_stats.py；只在临时目录验证 CLI。"""
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile


def main():
    with tempfile.TemporaryDirectory() as tmp:
        docs = Path(tmp)
        scripts = docs / 'scripts'
        scripts.mkdir()
        for name in ('ledger_stats.py', 'docs_lint.py'):
            shutil.copyfile(Path(__file__).with_name(name), scripts / name)
        ledger = docs / 'handbook' / '02-接单总台账'
        ledger.mkdir(parents=True)
        readme = ledger / 'README.md'
        readme.write_text('# 台账索引\n\n计数见各仓文件生成块。\n\n'
                          '| 仓文件 | 详录 |\n| --- | --- |\n'
                          '| [opencode.md](opencode.md) | 无 |\n', encoding='utf-8')
        source = ('# 台账\n\n活账 1 行 / 终态归档 1 行\n\n'
                  '## 活账\n\n| 2 | repo | #2 | — | open |\n\n'
                  '## 终态归档\n\n| 1 | repo | #1 | — | closed |\n')
        for name in ('maka.md', 'opencode.md'):
            (ledger / name).write_text(source, encoding='utf-8')
        readme_before = readme.read_bytes()

        def run(script, *args, code=0):
            result = subprocess.run([sys.executable, str(scripts / script), *args],
                                    cwd=docs, env={**os.environ, 'PYTHONDONTWRITEBYTECODE': '1'},
                                    capture_output=True, text=True)
            assert result.returncode == code, result.stdout + result.stderr
            return result.stdout

        run('ledger_stats.py', '--apply')
        assert readme.read_bytes() == readme_before, '生成统计不应改写 README'
        assert '2 个生成块，0 个失配' in run('ledger_stats.py', '--check')
        run('docs_lint.py')
        maka = ledger / 'maka.md'
        other_before = (ledger / 'opencode.md').read_bytes()
        extra = '| 3 | repo | #3 | — | open |\n\n'
        maka.write_text(maka.read_text(encoding='utf-8').replace('## 终态归档', extra + '## 终态归档'), encoding='utf-8')
        rows = [line for line in maka.read_bytes().splitlines() if line.startswith(b'|')]
        for script, args in [('ledger_stats.py', ('--check',)), ('docs_lint.py', ())]:
            output = run(script, *args, code=1)
            assert 'maka.md' in output and 'README.md' not in output and 'opencode.md' not in output, output
        run('ledger_stats.py', '--apply')
        assert readme.read_bytes() == readme_before
        assert (ledger / 'opencode.md').read_bytes() == other_before
        assert rows == [line for line in maka.read_bytes().splitlines() if line.startswith(b'|')]
        run('ledger_stats.py', '--check')
        run('docs_lint.py')
        refreshed = maka.read_bytes()
        run('ledger_stats.py', '--apply')
        assert maka.read_bytes() == refreshed, '--apply 应幂等'
        maka.write_text(source, encoding='utf-8')
        for script, args in [('ledger_stats.py', ('--check',)), ('docs_lint.py', ())]:
            output = run(script, *args, code=1)
            assert 'maka.md' in output and '缺少 stats 生成块' in output, output
        run('ledger_stats.py', '--apply')
        run('ledger_stats.py', '--check')
        run('docs_lint.py')
    print('PASS: README 不参与统计；失配定位到仓；缺块阻断；补块、行原文与幂等检查通过')


if __name__ == '__main__':
    main()
