#!/usr/bin/env bash
# 按 repos.tsv 还原到 BASE：优先远程 clone，远程失效（被删/下架）自动从 bundle 解包
# 用法: ./restore.sh [repos.tsv]   环境变量: BASE(默认 /e)、BUNDLE_DIR(默认 /e/backup-bundles)
set -uo pipefail
BASE=${BASE:-/e}
BUNDLE_DIR=${BUNDLE_DIR:-/e/backup-bundles}
KIT_DIR=$(cd "$(dirname "$0")" && pwd)
TSV=${1:-$KIT_DIR/repos.tsv}

ok=0 from_bundle=0 skip=0 fail=0
while IFS=$'\t' read -r path remote branch; do
  remote=${remote//$'\r'/}; branch=${branch//$'\r'/}  # 防 CRLF
  [ -n "$path" ] || continue
  target="$BASE/$path"
  if [ -d "$target" ]; then
    skip=$((skip+1)); continue
  fi
  # 分支为空时不传 -b（clone 默认分支）
  if [ -n "$remote" ] && git clone -q ${branch:+-b "$branch"} "$remote" "$target" 2>/dev/null; then
    ok=$((ok+1)); continue
  fi
  b="$BUNDLE_DIR/${path//\//__}.bundle"
  if [ -f "$b" ] && git clone -q ${branch:+-b "$branch"} "$b" "$target" 2>/dev/null; then
    if [ -n "$remote" ]; then git -C "$target" remote set-url origin "$remote"; fi
    from_bundle=$((from_bundle+1)); continue
  fi
  fail=$((fail+1))
  echo "FAIL $path (远程=${remote:-无}, bundle=$([ -f "$b" ] && echo 有 || echo 无))"
done < "$TSV"
echo "还原完成: 远程clone=$ok 从bundle=$from_bundle 已存在=$skip 失败=$fail"
if [ "$fail" -gt 0 ]; then exit 1; fi
