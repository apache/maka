#!/bin/bash
# finish-cleanup.sh — cc 大仓收尾（用户已确认口径：不要历史备份，直接重置 .git；interview 三副本已合并进 README.md/.gitignore）
# 用法: bash /Users/ggbdpq/cc/temp/finish-cleanup.sh
set -euo pipefail

echo "== 1) interview 副本清理 =="
rm -f /Users/ggbdpq/cc/guahub/interview/README_副本.md \
      /Users/ggbdpq/cc/guahub/interview/README-from-ggbdpq.md \
      /Users/ggbdpq/cc/guahub/interview/.gitignore_副本
echo "已删除 README_副本.md / README-from-ggbdpq.md / .gitignore_副本"

echo "== 2) 嵌套 .git 探测（repositories 下的独立仓按约定保持 gitlink） =="
find /Users/ggbdpq/cc -name .git -maxdepth 6 -not -path "*/node_modules/*" 2>/dev/null || true

echo "== 3) interview 自带历史迁出（内容入 cc 仓，历史放 ~/.archives 可恢复） =="
if [ -d /Users/ggbdpq/cc/guahub/interview/.git ]; then
  mkdir -p ~/.archives
  mv /Users/ggbdpq/cc/guahub/interview/.git ~/.archives/interview-git-20261025
  echo "interview/.git → ~/.archives/interview-git-20261025"
else
  echo "interview 无自带 .git，跳过"
fi

echo "== 4) cc 孤儿历史重置（rm .git → init → 单提交） =="
cd /Users/ggbdpq/cc
rm -rf .git
git init -b main
git add -A
git commit -m "chore: cc 个人工作区重建——孤儿单提交全量收编（知识库/项目仓/会话归档/运维脚本）"

echo "== 5) 验证 =="
git log --oneline
git status --short | head -5
echo "--- .git 体积 ---"
du -sh .git
echo "--- 各文件夹 README 就位 ---"
find . -maxdepth 3 -name "README.md" -not -path "*/node_modules/*" | sort

echo "== 6) 推送私人仓库 github.com/ggbdpq/cc =="
if ! git remote get-url origin >/dev/null 2>&1; then
  git remote add origin https://github.com/ggbdpq/cc.git
fi
git remote set-url origin https://github.com/ggbdpq/cc.git
# 孤儿单提交与远程历史不相关，覆盖推送（用户已确认重置口径）
git push -f origin main
echo "== 完成：远程 main 已替换为孤儿单提交 =="
