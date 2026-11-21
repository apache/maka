#!/bin/sh
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
target=${1:?usage: ROLLBACK.sh /private/tmp/magpie-quality-20261017-2413[-rollback]}
case "$target" in /private/tmp/magpie-quality-20261017-2413|/private/tmp/magpie-quality-20261017-2413-rollback) ;; *) echo 'unexpected target' >&2; exit 2 ;; esac
python3 - "$here" "$target" <<'PYROLLBACK'
import hashlib,json,pathlib,shutil,sys
here,target=map(pathlib.Path,sys.argv[1:])
manifest=json.loads((here/'source-manifest.json').read_text())
assert 'module github.com/yetone/magpie' in (target/'go.mod').read_text()
for entry in manifest['files']:
 source=here/'original'/entry['file']
 assert hashlib.sha256(source.read_bytes()).hexdigest()==entry['baseline_sha256'],entry['file']
 shutil.copyfile(source,target/entry['file'])
 assert hashlib.sha256((target/entry['file']).read_bytes()).hexdigest()==entry['baseline_sha256'],entry['file']
print('ROLLBACK_RESTORED=5_FILES BASE='+manifest['base'])
PYROLLBACK
