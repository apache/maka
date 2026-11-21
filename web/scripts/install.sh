#!/usr/bin/env bash
# install.sh — 一键安装 E:\guahub 各活跃子项目的依赖
# 用法: install.sh [--dry-run] [项目名]
# 说明: gh/fork 不在安装范围(maka 装依赖要配合工作区构建链, CLIProxyAPI 是 Go 无依赖可装)
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# 项目名 -> 要装依赖的目录列表(相对 E:\guahub); 每个目录按清单文件自动选命令
declare -A PROJECTS=(
  [agent-hub]="vibe/agent/agent-hub vibe/agent/agent-hub/apps/api"
  [console]="vibe/apps/console"
  [harness-deck]="vibe/apps/harness-deck"
  [token2agent]="vibe/apps/token2agent"
  [coding-agent]="vibe/labs/coding-agent/typescript vibe/labs/coding-agent/python vibe/labs/coding-agent/rust"
  [syntax-party]="vibe/labs/syntax-party"
  [design-archive]="vibe/tools/design-archive vibe/tools/design-archive/rust"
  [tapd-task-creator]="vibe/tools/tapd-task-creator"
  [cursor-loc]="vibe/gh/cursor-loc"
  [react-helper-toolkit]="vibe/gh/react-helper-toolkit"
)

usage() {
  echo "用法: install.sh [--dry-run] [项目名]"
  echo "  无参数     按顺序安装下方全部项目的依赖"
  echo "  <项目名>   只装指定项目"
  echo "  --dry-run  只显示每个目录将执行的命令, 不实际安装"
  echo "命令自动选择: pnpm-workspace/pnpm-lock -> pnpm, package-lock -> npm,"
  echo "              yarn.lock -> yarn, bun.lock -> bun, pyproject/uv.lock -> uv sync,"
  echo "              requirements.txt -> pip, Cargo.toml -> cargo fetch"
  echo "可用项目名: $(printf '%s\n' "${!PROJECTS[@]}" | sort | tr '\n' ' ')"
}

DRY=0 NAME=""
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    -h|--help) usage; exit 0 ;;
    *) [ -n "$NAME" ] && { echo "错误: 只支持一个项目名" >&2; exit 1; }
       NAME="$a" ;;
  esac
done

if [ -n "$NAME" ] && [ -z "${PROJECTS[$NAME]:-}" ]; then
  echo "错误: 未知项目 '$NAME'" >&2
  usage >&2
  exit 1
fi

# 按清单文件选安装命令; 找不到清单返回空(调用方跳过)
# ponytail: pyproject 一律 uv sync(uv 已在本机, 会自建 .venv); 非 uv 项目有意见再改这里
detect_cmd() {
  local d="$1"
  if [ -f "$d/pnpm-workspace.yaml" ] || [ -f "$d/pnpm-lock.yaml" ]; then
    echo "pnpm install"
  elif [ -f "$d/package-lock.json" ]; then
    echo "npm install"
  elif [ -f "$d/yarn.lock" ]; then
    echo "yarn install"
  elif [ -f "$d/bun.lock" ] || [ -f "$d/bun.lockb" ]; then
    echo "bun install"
  elif [ -f "$d/package.json" ]; then
    echo "npm install"
  elif [ -f "$d/uv.lock" ] || [ -f "$d/pyproject.toml" ]; then
    echo "uv sync"
  elif [ -f "$d/requirements.txt" ]; then
    echo "pip install -r requirements.txt"
  elif [ -f "$d/Cargo.toml" ]; then
    echo "cargo fetch"
  fi
}

# 展开成 (目录, 命令) 任务表
TASKS_D=() TASKS_C=()
for pname in $(if [ -n "$NAME" ]; then echo "$NAME"; else printf '%s\n' "${!PROJECTS[@]}" | sort; fi); do
  for rel in ${PROJECTS[$pname]}; do
    d="$ROOT/$rel"
    if [ ! -d "$d" ]; then
      echo "警告: 目录不存在, 跳过 $rel" >&2
      continue
    fi
    cmd="$(detect_cmd "$d")"
    if [ -z "$cmd" ]; then
      echo "跳过 $rel (没有可识别的依赖清单)"
      continue
    fi
    TASKS_D+=("$rel") TASKS_C+=("$cmd")
  done
done

echo "共 ${#TASKS_D[@]} 个安装任务${NAME:+ (项目: $NAME)}"
if (( DRY )); then
  for i in "${!TASKS_D[@]}"; do
    printf '[预览] %s\n        %s\n' "${TASKS_D[$i]}" "${TASKS_C[$i]}"
  done
  exit 0
fi

FAILED=()
for i in "${!TASKS_D[@]}"; do
  rel="${TASKS_D[$i]}" cmd="${TASKS_C[$i]}"
  printf '==> [%d/%d] %s\n        $ %s\n' "$(( i + 1 ))" "${#TASKS_D[@]}" "$rel" "$cmd"
  t0=$SECONDS
  if (cd "$ROOT/$rel" && $cmd); then
    printf '    ✓ 完成 (%ds)\n' "$(( SECONDS - t0 ))"
  else
    printf '    ✗ 失败 (退出码 %d, 见上方输出)\n' "$?"
    FAILED+=("$rel")
  fi
done

echo ""
echo "================ 安装报告 ================"
printf '完成 %d / %d 个任务, 用时 %ds\n' "$(( ${#TASKS_D[@]} - ${#FAILED[@]} ))" "${#TASKS_D[@]}" "$SECONDS"
if (( ${#FAILED[@]} )); then
  echo "失败清单(可单独重跑):"
  printf '  %s\n' "${FAILED[@]}"
  exit 1
fi
exit 0
