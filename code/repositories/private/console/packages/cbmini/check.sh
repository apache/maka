#!/bin/sh
# P04 回归：编译 → WSL 内运行 ELF → 对 expected（卡验收标准）
cd "$(dirname "$0")" || exit 1
# WSL 输出使用 UTF-8；stderr 仅在失败时显示，避免横幅干扰 stdout 比对。
export WSL_UTF8=1
mkdir -p out
fails=""
for f in tests/cases/*.cb; do
  name=$(basename "$f" .cb)
  if ! node src/main.ts -o "out/$name" "$f"; then
    echo "FAIL $name (compile)"
    fails="$fails $name"
    continue
  fi
  got=$(wsl.exe --cd "$(pwd -W)" "./out/$name" 2>"out/$name.stderr")
  exit_code=$?
  want=$(cat "tests/expected/$name.txt")
  if [ "$exit_code" -eq 0 ] && [ "$got" = "$want" ]; then
    echo "OK $name"
  else
    echo "FAIL $name (exit=$exit_code)"
    cat "out/$name.stderr" >&2
    echo "  got:  $got"
    echo "  want: $want"
    fails="$fails $name"
  fi
done
if [ -z "$fails" ]; then
  echo "all green"
else
  echo "failed:$fails"
  exit 1
fi
