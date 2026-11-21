#!/usr/bin/env bash
# 扫描本机 git 仓库，生成 repos.tsv：路径(相对 BASE) <TAB> 远程 <TAB> 分支
# 用法: ./scan.sh [输出文件]   环境变量: BASE(默认 /e)、ROOTS(扫描根列表，空格分隔)
set -euo pipefail
BASE=${BASE:-/e}
KIT_DIR=$(cd "$(dirname "$0")" && pwd)
ROOTS=${ROOTS:-"$BASE/ggbdpq/github"}
OUT=${1:-$KIT_DIR/repos.tsv}

: > "$OUT"
for root in $ROOTS; do
  [ -d "$root" ] || continue
  while IFS= read -r gitdir; do
    repo=${gitdir%/.git}
    path=${repo#"$BASE"/}
    case "$path" in
      # 维护约定：_archive 与 github/other 整体跳过；wechat 两个死仓（远程已删，见 UPDATELOG 永久跳过清单）随迁入 wechat/ 后继续跳过；maka-pr* 是历史 PR 一次性工作副本
      # github 容器仓（本账本仓）自身不入清单
      *_archive/*|*github/other/*|*github/wechat/CipherTalk|*github/wechat/LOGO127-wechat-ai-memory|ggbdpq/gh-fork/maka-pr*|github) continue ;;
    esac
    remote=$(git -C "$repo" remote get-url origin 2>/dev/null || true)
    branch=$(git -C "$repo" rev-parse --abbrev-ref HEAD 2>/dev/null || true)
    if [ "$branch" = "HEAD" ]; then branch=""; fi  # detached HEAD 不记分支
    printf '%s\t%s\t%s\n' "$path" "$remote" "$branch" >> "$OUT"
  done < <(find "$root" -maxdepth 4 -name .git -type d 2>/dev/null)
done

total=$(wc -l < "$OUT")
echo "共 $total 个仓库 → $OUT"
if grep -Pq '\t\t|\t$' "$OUT"; then
  echo "⚠ 以下仓库无远端（还原只能靠 bundle）："
  grep -P '\t\t|\t$' "$OUT"
fi
