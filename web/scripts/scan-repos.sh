#!/usr/bin/env bash
# scan-repos.sh — 扫描 cc 下全部独立 git 仓库，生成 web/docs/sessions/curated/projects/独立仓库清单.md
# 用法: bash ~/cc/web/scripts/scan-repos.sh   （收录新仓库后重跑，输出整体覆盖）
set -euo pipefail

CC_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT="$CC_ROOT/web/docs/sessions/curated/projects/独立仓库清单.md"
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

while IFS= read -r gitdir; do
  top="$(dirname "$gitdir")"
  rel="${top#"$CC_ROOT"/}"
  [ "$rel" = "$top" ] && continue   # cc 仓库自身，跳过
  url="$(git -C "$top" remote get-url origin 2>/dev/null || echo 无远端)"
  note=""
  [ -f "$gitdir" ] && note="worktree"
  printf '%s\t%s\t%s\n' "$rel" "$url" "$note" >> "$tmp"
done < <(find "$CC_ROOT" -name ".git" -not -path "*/node_modules/*")

{
  echo "# cc 下独立仓库清单"
  echo
  echo "> 由 web/scripts/scan-repos.sh 扫描生成（$(date +%F)，共 $(wc -l < "$tmp" | tr -d ' ') 个）。"
  echo "> 独立项目各自 git 管理，cc/home 仓库只留本清单作轮廓；收录新仓库后重跑。"
  echo
  echo "| 路径(相对 cc) | 远端 | 备注 |"
  echo "|---|---|---|"
  sort "$tmp" | while IFS="$(printf '\t')" read -r rel url note; do
    echo "| $rel | $url | $note |"
  done
} > "$OUT"
echo "已生成 ${OUT}（$(wc -l < "$tmp" | tr -d ' ') 个仓库）"
