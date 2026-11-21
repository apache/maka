#!/usr/bin/env bash
# 研究暂存区瘦身克隆脚本
# 策略：--depth 1 浅克隆 → 删 .git + >1MB 二进制 → 保留所有 md/代码 + 小图
# 可逆：architecture 是普通目录，不满意 rm -rf 重来
set -u
cd "$HOME/.agents/architecture" || exit 1

REPOS=(
  "mattpocock/skills"
  "obra/superpowers"
  "code-yeongyu/oh-my-openagent"
  "garrytan/gstack"
  "code-yeongyu/lazycodex"
  "kunchenguid/no-mistakes"
  "EveryInc/compound-engineering-plugin"
)

# 瘦身：删 .git + 大二进制 + OS 噪声；保留文本与小图
slim() {
  local d="$1"
  rm -rf "$d/.git"
  find "$d" -type f \( \
    -iname '*.png'  -o -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.gif' \
    -o -iname '*.mp4' -o -iname '*.webm' -o -iname '*.mov' -o -iname '*.avi' \
    -o -iname '*.pdf' -o -iname '*.zip' -o -iname '*.tar' -o -iname '*.gz' \
    -o -iname '*.bin' -o -iname '*.exe' -o -iname '*.dll' -o -iname '*.so' \
    -o -iname '*.woff' -o -iname '*.woff2' -o -iname '*.ttf' -o -iname '*.ico' \
  \) -size +1M -delete
  find "$d" -name '.DS_Store' -delete 2>/dev/null
}

for spec in "${REPOS[@]}"; do
  owner="${spec%/*}"; repo="${spec#*/}"
  target="$owner/$repo"
  mkdir -p "$owner"
  echo "----------------------------------------"
  if [ -d "$target/.git" ] || [ -d "$target" ] && [ "$(ls -A "$target" 2>/dev/null | head -1)" ]; then
    echo "[skip-clone] $target (已存在)"
  else
    echo "[clone] $spec (--depth 1, 无 recursive)"
    if git clone --depth 1 "https://github.com/$spec.git" "$target" 2>"/tmp/clone-$repo.err"; then
      echo "[ok] cloned"
    else
      echo "[FAIL] $spec : $(cat "/tmp/clone-$repo.err" 2>/dev/null | head -3)"
      continue
    fi
  fi
  before=$(du -sm "$target" 2>/dev/null | cut -f1)
  echo "[slim] $target ..."
  slim "$target"
  after=$(du -sm "$target" 2>/dev/null | cut -f1)
  echo "[done] $target: ${before}MB -> ${after}MB"
done

echo "========================================"
echo "ALL DONE — 瘦身后各仓库体积："
du -sh */*/ 2>/dev/null | sort -rh
echo "---- architecture 总体积 ----"
du -sh "$HOME/.agents/architecture" 2>/dev/null
