#!/usr/bin/env bash
# 端到端自测：扫描 → 备份 → 模拟远程被删 → bundle 还原 → 正常 clone。通过打印"全部通过"。
set -euo pipefail
KIT_DIR=$(cd "$(dirname "$0")" && pwd)
T=$(mktemp -d)
trap 'rm -rf "$T" || true' EXIT
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t

# 1. 造一个"远程"仓库和一个已克隆的本地仓
git init -q --bare "$T/origin.git"
git clone -q "$T/origin.git" "$T/base/github/g/r"
echo hi > "$T/base/github/g/r/a.txt"
git -C "$T/base/github/g/r" add -A
git -C "$T/base/github/g/r" commit -qm init
git -C "$T/base/github/g/r" push -q origin HEAD

# 2. scan 识别到它
ROOTS="$T/base/github" BASE="$T/base" bash "$KIT_DIR/scan.sh" "$T/repos.tsv" > /dev/null
[ "$(wc -l < "$T/repos.tsv")" = 1 ] || { echo "FAIL: scan 行数不为 1"; exit 1; }

# 3. backup 产出 bundle
BASE="$T/base" BUNDLE_DIR="$T/bundles" bash "$KIT_DIR/backup.sh" "$T/repos.tsv" > /dev/null
[ -f "$T/bundles/github__g__r.bundle" ] || { echo "FAIL: bundle 未产出"; exit 1; }

# 4. 模拟远程被原作者删除
mv "$T/origin.git" "$T/origin.gone"

# 5. restore 应从 bundle 还原，origin 指回原远程地址
rm -rf "$T/base/github/g/r"
BASE="$T/base" BUNDLE_DIR="$T/bundles" bash "$KIT_DIR/restore.sh" "$T/repos.tsv" > /dev/null
[ -f "$T/base/github/g/r/a.txt" ] || { echo "FAIL: bundle 还原缺文件"; exit 1; }
# MSYS 会把 /tmp 路径转成 Windows 形式存储，无法字符串精确比对；只断言 origin 不再指向 bundle
case "$(git -C "$T/base/github/g/r" remote get-url origin)" in
  *.bundle) echo "FAIL: origin 仍指向 bundle"; exit 1 ;;
esac

# 6. 远程健在时走正常 clone
mv "$T/origin.gone" "$T/origin.git"
rm -rf "$T/base/github/g/r"
BASE="$T/base" BUNDLE_DIR="$T/bundles" bash "$KIT_DIR/restore.sh" "$T/repos.tsv" > /dev/null
[ -f "$T/base/github/g/r/a.txt" ] || { echo "FAIL: 正常 clone 缺文件"; exit 1; }

echo "test.sh: 全部通过"
