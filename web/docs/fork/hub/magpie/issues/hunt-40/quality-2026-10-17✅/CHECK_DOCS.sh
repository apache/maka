#!/bin/sh
set -eu
d=${1:?usage: CHECK_DOCS.sh HANDBOOK_DIR}
for n in 05-缺陷狩猎经验.md 06-会话开场提示词.md 07-哨兵任务书.md; do
  test -f "$d/$n"
done
if ! grep -Fq 'docs/contributors.md' "$d/05-缺陷狩猎经验.md"; then
  echo 'FAIL: current contributor gate missing'
  exit 1
fi
if grep -En '用户 KPI|验证完立刻发|忽略即可|git stash --|改文件即改任务|补提请求并催关单' "$d/05-缺陷狩猎经验.md" "$d/06-会话开场提示词.md" "$d/07-哨兵任务书.md"; then
  echo 'FAIL: stale bypass or publication directive remains'
  exit 1
fi
for n in 06-会话开场提示词.md 07-哨兵任务书.md; do
  grep -Fq '05-缺陷狩猎经验.md#2-' "$d/$n"
done
echo 'PASS: contributor gate linked; no stale bypass directives; 06/07 reference 05'
