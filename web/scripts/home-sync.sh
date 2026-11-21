#!/bin/sh
# home-sync.sh — 家目录 dotfiles 仓（~ = C-Users-ggbdpq）的安全同步。
#
# 背景（2026-10-13 事故）：ZCode 的 AI 自动化任务「拉取远程代码并解决冲突」在家
# 目录仓执行了 git reset --hard FETCH_HEAD + git sparse-checkout（收窄到两个
# .codex 子目录），把 .ai 技能库（1890 个 SKILL.md）、.githooks、.zcode/AGENTS.md
# 等全部跟踪文件从工作区摘帽，.zcode 未跟踪的会话/登录态同批丢失。sparse-checkout
# disable 后跟踪文件全部恢复，但此类操作任何 hook 都拦不住——只能让同步本身不再
# 经过 AI。
#
# 本脚本只做确定性操作：
#   1. git fetch origin
#   2. 本地落后 → 快进合并（--ff-only）；本地超前 → push；分叉 → 停止并报告
#   3. 发现 sparse-checkout 处于收窄状态 → 自动 disable（摘帽即丢工作区文件的前兆）
#   4. --commit-all：先把全部变动以固定信息提交再同步（替代「提交本地修改」自动化）
#
# 永不执行：reset --hard、clean、sparse-checkout set、rm 及任何删除未跟踪文件的操作。
#
# 若改用 AI 自动化执行同步，提示词必须包含以下硬约束（逐字）：
#   禁止执行 git reset --hard、git clean、git sparse-checkout、rm -rf 及任何删除
#   未跟踪文件的命令；只允许 git fetch 与 git merge --ff-only；遇冲突立即停止并
#   原样报告，不得自行解决。
set -eu

cd "$HOME"

branch=$(git symbolic-ref --short HEAD 2>/dev/null) || {
  echo "家目录仓处于游离 HEAD，停止" >&2; exit 1; }

if [ "${1:-}" = "--commit-all" ]; then
  if [ -n "$(git status --porcelain)" ]; then
    git add -A
    git commit -q -m "chore(sync): home-sync 自动入库 $(date '+%Y-%m-%d %H:%M')"
    echo "已提交本地变动"
  fi
fi

git fetch origin

local_sha=$(git rev-parse HEAD)
remote_sha=$(git rev-parse "origin/$branch")

if [ "$local_sha" = "$remote_sha" ]; then
  :
elif git merge-base --is-ancestor HEAD "origin/$branch"; then
  git merge --ff-only -q "origin/$branch"
  echo "已快进 $branch -> $(git rev-parse --short HEAD)"
elif git merge-base --is-ancestor "origin/$branch" HEAD; then
  git push origin "$branch"
  echo "已推送 $branch -> origin"
else
  echo "分叉：本地与 origin/$branch 各有提交，停止自动同步，请人工处理" >&2
  exit 1
fi

# sparse 收窄检查：正常工作区不应启用（2026-10-13 / 2026-10-18 事故的摘帽路径）。
# 模式文件比 config 更危险：config=true 且残留旧锥形时，下一次 reset/checkout
# 就会按旧锥形清空工作区，所以两个条件都要查。~/.git/info 可能带 uchg（防收窄），
# 清理时临时解锁再复锁；非 macOS 没有 chflags，忽略即可。
if [ -f .git/info/sparse-checkout ]; then
  chflags nouchg .git/info 2>/dev/null || true
  echo "警告：发现 sparse-checkout 模式文件，正在清理并恢复完整工作区" >&2
  rm -f .git/info/sparse-checkout
  git sparse-checkout disable 2>/dev/null || true
  chflags uchg .git/info 2>/dev/null || true
fi
if [ "$(git config --bool core.sparseCheckout 2>/dev/null)" = "true" ]; then
  echo "警告：core.sparseCheckout=true，正在关闭以恢复完整工作区" >&2
  git sparse-checkout disable 2>/dev/null || true
fi

echo "同步完成：$branch @ $(git rev-parse --short HEAD)"
