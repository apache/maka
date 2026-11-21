#!/usr/bin/env bash
# 对 repos.tsv 每个仓库做 git bundle --all，落到 BUNDLE_DIR
# 建议 BUNDLE_DIR 指向移动硬盘或网盘同步目录，防整盘损坏
# 用法: ./backup.sh [repos.tsv]   环境变量: BASE(默认 /e)、BUNDLE_DIR(默认 /e/backup-bundles)
set -uo pipefail
BASE=${BASE:-/e}
BUNDLE_DIR=${BUNDLE_DIR:-/e/backup-bundles}
KIT_DIR=$(cd "$(dirname "$0")" && pwd)
TSV=${1:-$KIT_DIR/repos.tsv}
mkdir -p "$BUNDLE_DIR"

ok=0 miss=0 fail=0
while IFS=$'\t' read -r path remote branch; do
  path=${path//$'\r'/}
  [ -n "$path" ] || continue
  repo="$BASE/$path"
  if [ ! -d "$repo" ]; then
    miss=$((miss+1)); echo "MISS $path"; continue
  fi
  if git -C "$repo" bundle create -q "$BUNDLE_DIR/${path//\//__}.bundle" --all 2>/dev/null; then
    ok=$((ok+1))
  else
    fail=$((fail+1)); echo "FAIL $path"
  fi
done < "$TSV"
echo "bundle 完成: 成功=$ok 缺目录=$miss 失败=$fail → $BUNDLE_DIR"
if [ "$fail" -gt 0 ]; then exit 1; fi
