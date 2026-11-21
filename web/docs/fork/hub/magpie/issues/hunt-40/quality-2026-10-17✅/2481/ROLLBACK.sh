#!/bin/sh
set -eu
base=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
target=${1:?usage: ROLLBACK.sh /absolute/path/to/patched-copy}
case "$target" in /*) ;; *) printf '%s\n' 'target must be an absolute path' >&2; exit 2;; esac
cd "$target"
git apply --reverse --check "$base/updated.patch"
git apply --reverse "$base/updated.patch"
printf '%s\n' 'ROLLBACK: restored all three patched files to the fixed main'
