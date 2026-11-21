#!/usr/bin/env bash
# clean.sh — 清理 E:\guahub 各项目的构建物与缓存
# 用法: clean.sh [--dry-run] [--include-forks] [项目名]
set -u

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

# 固定模式: 项目名 -> 仓库根(相对 E:\guahub, 空格分隔可写多个)
# 只清该根下的白名单目录, 不受 gh/fork 豁免限制
declare -A FIXED=(
  [agent-hub]="vibe/agent/agent-hub"
  [console]="vibe/apps/console"
  [harness-deck]="vibe/apps/harness-deck"
  [token2agent]="vibe/apps/token2agent"
  [coding-agent]="vibe/labs/coding-agent"
  [syntax-party]="vibe/labs/syntax-party"
  [design-archive]="vibe/tools/design-archive"
  [linkpull]="vibe/tools/linkpull"
  [tapd-task-creator]="vibe/tools/tapd-task-creator"
  [cursor-loc]="vibe/gh/cursor-loc"
  [react-helper-toolkit]="vibe/gh/react-helper-toolkit"
  [maka]="gh/fork/maka"
  [cliproxyapi]="gh/fork/CLIProxyAPI"
  [fanlei13]="xiaojingmo/Fanlei13"
  [lambda-lambda]="xiaojingmo/lambda-lambda"
  [pingfandang]="xiaojingmo/pingfandang"
)

# 动态模式的删除白名单: 只删这些名字的目录, 其余一概不碰
# 注意: 不收 build —— pure-admin 的 build/ 是构建脚本源码, portaudio 的 build/ 是随源码分发的
# 工程文件, 收进来会误删已跟踪源码(实测 2026-09-19)
WHITELIST=(node_modules dist .next .nuxt .svelte-kit .turbo .vite
           coverage __pycache__ .pytest_cache .mypy_cache .ruff_cache
           target .gradle .venv venv)

usage() {
  echo "用法: clean.sh [--dry-run] [--include-forks] [项目名]"
  echo "  无参数           动态扫描整个 E:\\guahub, 删除白名单内的构建物/缓存目录"
  echo "  <项目名>         只清理指定项目(写死映射), 不受 fork 豁免限制"
  echo "  --dry-run        只预览与统计, 不删除"
  echo "  --include-forks  动态模式下不跳过 gh/fork(默认跳过, 保护贡献工作区)"
  echo "可用项目名: $(printf '%s\n' "${!FIXED[@]}" | sort | tr '\n' ' ')"
}

DRY=0 FORKS=0 NAME=""
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    --include-forks) FORKS=1 ;;
    -h|--help) usage; exit 0 ;;
    *) [ -n "$NAME" ] && { echo "错误: 只支持一个项目名" >&2; exit 1; }
       NAME="$a" ;;
  esac
done

if [ -n "$NAME" ] && [ -z "${FIXED[$NAME]:-}" ]; then
  echo "错误: 未知项目 '$NAME'" >&2
  usage >&2
  exit 1
fi

human() {
  awk -v k="$1" 'BEGIN{ if(k>=1048576) printf "%.2fGB",k/1048576; else if(k>=1024) printf "%.1fMB",k/1024; else printf "%dKB",k }'
}

# 归属项目 = 最近一层含 .git/package.json/pyproject.toml 的祖先, 兜底为根目录杂项
# ponytail: 纯展示用启发式, 不影响删除范围; 报告分组不准时改这里
proj_root() {
  local d="$1"
  while [ "$d" != "$ROOT" ]; do
    if [ -e "$d/.git" ] || [ -e "$d/package.json" ] || [ -e "$d/pyproject.toml" ]; then
      printf '%s\n' "${d#"$ROOT"/}"
      return
    fi
    d="$(dirname "$d")"
  done
  printf '(根目录杂项)\n'
}

# 组装 find 用的目录名测试: (-name a -o -name b ... -name venv)
NT=()
for n in "${WHITELIST[@]}"; do NT+=(-name "$n" -o); done
unset "NT[$(( ${#NT[@]} - 1 ))]"

# 确定扫描范围: 固定模式用映射的仓库根, 动态模式用整个 E:\guahub
SCOPES=()
if [ -n "$NAME" ]; then
  for rel in ${FIXED[$NAME]}; do
    if [ -d "$ROOT/$rel" ]; then
      SCOPES+=("$ROOT/$rel")
    else
      echo "警告: 目录不存在, 跳过 $rel" >&2
    fi
  done
  [ "${#SCOPES[@]}" -gt 0 ] || { echo "错误: $NAME 没有可用的目录" >&2; exit 1; }
else
  SCOPES+=("$ROOT")
fi

# 动态模式默认把 gh/fork 整棵剪掉(贡献工作区, 重装重建成本高); 固定模式不剪
# 注意: 剪枝组必须连 -o 一起整体进数组, 空数组时整组消失,
# 否则退化成裸 -prune 会把一切剪光(实测 2026-09-19)
PRUNE_FORKS=()
if (( ! FORKS )) && [ -z "$NAME" ]; then
  PRUNE_FORKS=( \( -path "$ROOT/gh/fork" -prune \) -o )
fi

echo "扫描中 (根: $ROOT${NAME:+, 项目: $NAME})..."
DIRS=()
while IFS= read -r -d '' d; do DIRS+=("$d"); done < <(
  find "${SCOPES[@]}" \
    ${PRUNE_FORKS[@]+"${PRUNE_FORKS[@]}"} \
    \( -name .git -prune \) -o \
    \( -type d \( "${NT[@]}" \) -prune -print0 \) 2>/dev/null
)

echo "命中 ${#DIRS[@]} 个目录, 统计空间并删除中..."

declare -A PC=() PSZ=()
TOTAL=0 TK=0
FAILED=()

for d in "${DIRS[@]}"; do
  k="$(du -sk -- "$d" 2>/dev/null | cut -f1)"; k="${k:-0}"
  rel="${d#"$ROOT"/}"
  p="$(proj_root "$d")"
  PC["$p"]=$(( ${PC["$p"]:-0} + 1 ))
  PSZ["$p"]=$(( ${PSZ["$p"]:-0} + k ))
  TOTAL=$(( TOTAL + 1 ))
  TK=$(( TK + k ))
  if (( DRY )); then
    printf '[预览] %s (%s)\n' "$rel" "$(human "$k")"
  else
    rm -rf -- "$d" || FAILED+=("$d")
    printf '.' >&2
  fi
done
if (( ! DRY )); then echo "" >&2; fi

if (( TOTAL == 0 )); then
  echo "未命中任何白名单目录, 无事可做"
  exit 0
fi

echo ""
echo "================ 清理报告 ================"
while IFS= read -r p; do
  printf '%-44s %4d 项  %10s\n' "$p" "${PC["$p"]}" "$(human "${PSZ["$p"]}")"
done < <(printf '%s\n' "${!PC[@]}" | sort)

if (( ${#FAILED[@]} )); then
  echo ""
  echo "删除失败 ${#FAILED[@]} 个(进程占用/权限), 稍后重跑即可:"
  printf '  %s\n' "${FAILED[@]}"
fi

echo ""
if (( DRY )); then
  printf '总计: %d 个目录, 可释放 %s (dry-run, 未删除)\n' "$TOTAL" "$(human "$TK")"
else
  printf '总计: 已删除 %d 个目录, 释放 %s\n' "$TOTAL" "$(human "$TK")"
fi
(( ${#FAILED[@]} )) && exit 1
exit 0
