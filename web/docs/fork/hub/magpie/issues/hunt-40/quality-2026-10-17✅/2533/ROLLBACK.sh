#!/bin/bash
set -euo pipefail
root=${1:?usage: ROLLBACK.sh ISOLATED_SOURCE_DIRECTORY}
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
test -f "$root/go.mod"
git -C "$root" apply --reverse --check "$here/updated.patch"
git -C "$root" apply --reverse "$here/updated.patch"
printf 'ROLLBACK: restored 3 product files and routing reference; removed the added regression test\n'
