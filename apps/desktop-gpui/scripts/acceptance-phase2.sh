#!/usr/bin/env bash
# Licensed to the Apache Software Foundation (ASF) under one
# or more contributor license agreements.  See the NOTICE file
# distributed with this work for additional information
# regarding copyright ownership.  The ASF licenses this file
# to you under the Apache License, Version 2.0 (the
# "License"); you may not use this file except in compliance
# with the License.  You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing,
# software distributed under the License is distributed on an
# "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
# KIND, either express or implied.  See the License for the
# specific language governing permissions and limitations
# under the License.

# Phase 2 acceptance run (docs/plan/phase-2-daily-use.md, "Acceptance for
# Phase 2") against a fresh State Root and the built bundle. The report of
# the 2026-09-26 run is docs/acceptance/phase-2-2026-09-26.md.
#
#   scripts/acceptance-phase2.sh <step>…
#
# Steps, in the order they were run:
#   preflight  disk, bundle, examples, Ollama, fresh root, workspace
#   1          first launch without --root: the State Root dialog (screenshot only)
#   2          launch with --root: the app spawns an ephemeral Host
#   3          add the Ollama connection through the Add connection form
#   6          model switch phi4 and back (live_turn); also makes the first task,
#              which live_sidebar needs before it does anything
#   4          register the project, ⌘N, --send a tool prompt
#   4b         the tool prompt on qwen2.5:7b through live_turn, opened in the bundle
#   5          a long turn and a queued follow-up
#   6b         the bundle's model menu on the ⌘N task
#   7          quit, Host idle exit, relaunch
#   8          relaunch in zh-CN
#   cleanup    quit our instances, wait for the Host to exit, delete the root
#
# The app is started with `open`, which passes the calling shell's
# environment on (packaging/README.md says otherwise; see the report), so it
# is started without MAKA_REPO, MAKA_NODE, or provider keys and with
# launchd's default PATH, as from Finder. The examples run from this shell
# without the provider keys, so a Host they might start imports none.
# Only processes started here are stopped (SIGTERM): instances of this
# checkout's bundle (preflight refuses to start while one runs) and example
# pids from `$!`; the ephemeral Host is left to exit by itself.
# Screenshots go to docs/design/screenshots/acceptance-*.png, logs and state
# to target/acceptance-run/.
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="${ACCEPTANCE_ROOT:-$repo/target/acceptance-root}"
RUN="$repo/target/acceptance-run"
WS=/private/tmp/maka-gpui-acceptance-workspace
APP="$repo/target/bundle/Maka GPUI.app"
BIN="$APP/Contents/MacOS/maka-gpui"
EX="$repo/target/debug/examples"
SHOTS="$repo/docs/design/screenshots"
SLUG=ollama-local
STATE="$RUN/state.env"
CLEAN_ENV=(env -u DEEPSEEK_API_KEY -u ANTHROPIC_API_KEY -u OPENAI_API_KEY -u MAKA_REPO -u MAKA_NODE)
LAUNCHD_PATH=/usr/bin:/bin:/usr/sbin:/sbin
TOOL_PROMPT="List the files here with a tool, then summarize them in two sentences"
COUNT_PROMPT="Count from 1 to 400, one number per line, with no other text."
# The follow-up is the tool prompt again, a second try on the ⌘N task.
FOLLOWUP_PROMPT="$TOOL_PROMPT"

mkdir -p "$RUN/frames" "$SHOTS"
touch "$STATE"
# shellcheck disable=SC1090
source "$STATE"

say() { printf '\n== %s\n' "$*"; }
remember() { # key value
  grep -v "^$1=" "$STATE" >"$STATE.tmp" || true
  printf '%s=%q\n' "$1" "$2" >>"$STATE.tmp"
  mv "$STATE.tmp" "$STATE"
  eval "$1=\$2"
}

# Waits until `file` has a line matching the extended regex, prints it.
wait_line() { # file regex timeout-seconds
  local deadline=$((SECONDS + $3))
  while ((SECONDS < deadline)); do
    if grep -Eq -- "$2" "$1" 2>/dev/null; then
      grep -Em1 -- "$2" "$1"
      return 0
    fi
    sleep 0.2
  done
  echo "timed out after $3 s waiting for /$2/ in $1" >&2
  return 1
}

# Waits until `file` has at least `count` lines matching the regex.
wait_count() { # file regex count timeout-seconds
  local deadline=$((SECONDS + $4))
  while ((SECONDS < deadline)); do
    if (($(grep -Ec -- "$2" "$1" 2>/dev/null || true) >= $3)); then return 0; fi
    sleep 0.5
  done
  echo "timed out after $4 s waiting for $3 x /$2/ in $1" >&2
  return 1
}

window_id() { # pid
  [[ -x "$RUN/window-id" ]] || swiftc -O "$repo/scripts/window-id.swift" -o "$RUN/window-id"
  "$RUN/window-id" "$1"
}

shot() { # pid name
  local info out="$SHOTS/acceptance-$2.png"
  info="$(window_id "$1")"
  screencapture -x -o -l "${info%% *}" "$out"
  echo "screenshot $out (window $info)"
}

bundle_pids() { pgrep -f "Maka GPUI.app/Contents/MacOS/maka-gpui" || true; }

# Opens the bundle the way Finder does and prints the new instance's pid.
launch() { # log args…
  local log="$1" before pid
  shift
  before="$(bundle_pids)"
  : >"$log"
  # `open` passes this shell's environment on to the app (and the app to the
  # Host it starts), so strip it to what a Finder launch has.
  "${CLEAN_ENV[@]}" PATH="$LAUNCHD_PATH" \
    open -n --stderr "$log" --stdout "$log.stdout" "$APP" --args "$@"
  for _ in $(seq 1 50); do
    for pid in $(bundle_pids); do
      if ! grep -qx "$pid" <<<"$before"; then
        echo "$pid"
        return 0
      fi
    done
    sleep 0.2
  done
  echo "the bundle did not start" >&2
  return 1
}

# Stops one of our own processes with SIGTERM and waits for it to exit.
stop() { # pid what
  local pid="$1"
  [[ -n "$pid" ]] || return 0
  if ! kill -0 "$pid" 2>/dev/null; then return 0; fi
  # Refuse anything that is not ours: this checkout's bundle (preflight
  # checked that none ran before) or one of its examples.
  local command
  command="$(ps -o command= -p "$pid" || true)"
  if [[ "$command" != "$BIN"* && "$command" != "$EX/"* ]]; then
    echo "refusing to stop $pid ($command)" >&2
    return 1
  fi
  kill -TERM "$pid"
  for _ in $(seq 1 50); do
    kill -0 "$pid" 2>/dev/null || { echo "stopped $2 (pid $pid) with SIGTERM"; return 0; }
    sleep 0.2
  done
  echo "$2 (pid $pid) did not exit within 10 s" >&2
  return 1
}

root_id() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["rootId"])' "$ROOT/.maka-storage-root.json"; }
control_dir() { echo "$HOME/Library/Caches/Maka/runtime-hosts/$(root_id)"; }
registration() { echo "$(control_dir)/registration.json"; }
host_pid() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["pid"])' "$(registration)"; }

show_registration() {
  local reg
  reg="$(registration)"
  echo "control directory $(control_dir):"
  ls -la "$(control_dir)"
  python3 - "$reg" <<'PY'
import json, sys
r = json.load(open(sys.argv[1]))
keep = {k: r.get(k) for k in ("rootId", "pid", "lifecycleMode", "hostEpoch")}
keep["endpoint"] = r.get("endpoint", {}).get("kind") if isinstance(r.get("endpoint"), dict) else r.get("endpoint")
print("registration.json:", json.dumps(keep))
PY
}

# Captures window frames every 0.3 s until the log matches `until`.
frames() { # pid prefix log until timeout
  local deadline=$((SECONDS + $5)) n=0 info
  while ((SECONDS < deadline)); do
    if info="$(window_id "$1" 2>/dev/null)"; then
      screencapture -x -o -l "${info%% *}" "$RUN/frames/$2-$(printf %03d $n).png" || true
      n=$((n + 1))
    fi
    grep -Eq -- "$4" "$3" 2>/dev/null && break
    sleep 0.3
  done
  echo "captured $n frames as $RUN/frames/$2-*.png"
}

step_preflight() {
  say "preflight"
  local avail_kb
  avail_kb="$(df -k "$HOME" | awk 'NR==2 {print $4}')"
  df -h "$HOME" | tail -1
  if ((avail_kb < 6 * 1024 * 1024)); then
    echo "less than 6 GB free; aborting" >&2
    exit 1
  fi
  git -C "$repo" log -1 --format='HEAD %h %s'
  git -C "$repo" status --short
  [[ -x "$BIN" ]] || "$repo/scripts/bundle-macos.sh"
  ls -la "$BIN"
  (cd "$repo" && cargo build -q -p app --example live_add_connection --example live_sidebar \
    && cargo build -q -p conversation --example live_turn)
  curl -sf -m 5 http://127.0.0.1:11434/v1/models \
    | python3 -c 'import json,sys; print("ollama models:", [m["id"] for m in json.load(sys.stdin)["data"]])'
  if [[ -e "$ROOT" ]]; then
    echo "$ROOT exists; this run needs a fresh State Root" >&2
    exit 1
  fi
  if [[ -n "$(bundle_pids)" ]]; then
    echo "a Maka GPUI bundle instance is already running: $(bundle_pids)" >&2
    exit 1
  fi
  local remembered="$HOME/Library/Application Support/maka-gpui/state-root.json"
  [[ -e "$remembered" ]] && echo "remembered root: $(cat "$remembered")" || echo "no remembered State Root ($remembered)"
  for key in DEEPSEEK_API_KEY ANTHROPIC_API_KEY OPENAI_API_KEY MAKA_REPO MAKA_NODE; do
    echo "launchd $key: $([[ -n "$(launchctl getenv "$key")" ]] && echo set || echo unset)"
  done
  mkdir -p "$WS"
  [[ -e "$WS/README.md" ]] || printf '# Acceptance workspace\n\nA scratch folder for the Maka GPUI Phase 2 acceptance run.\n' >"$WS/README.md"
  [[ -e "$WS/greet.py" ]] || printf 'def greet(name):\n    return f"Hello, {name}!"\n\n\nprint(greet("Maka"))\n' >"$WS/greet.py"
  ls -la "$WS"
}

step_1() {
  say "1: first launch without --root"
  local pid
  pid="$(launch "$RUN/step1.log")"
  echo "bundle pid $pid (no --root)"
  sleep 4
  shot "$pid" 1-state-root-dialog
  stop "$pid" "the first-launch window"
  echo "log:"
  cat "$RUN/step1.log"
  local remembered="$HOME/Library/Application Support/maka-gpui/state-root.json"
  [[ -e "$remembered" ]] && echo "state-root.json now exists" || echo "state-root.json still absent: nothing was chosen"
}

step_2() {
  say "2: launch with --root $ROOT"
  local pid
  pid="$(launch "$RUN/step2.log" --root "$ROOT")"
  remember APP_PID "$pid"
  echo "bundle pid $pid"
  frames "$pid" step2 "$RUN/step2.log" 'connected to Runtime Host' 60
  # The first frame is taken while the Host starts ("Starting Maka…").
  cp "$RUN/frames/step2-000.png" "$SHOTS/acceptance-2-starting.png"
  wait_line "$RUN/step2.log" 'connected to Runtime Host' 60 >/dev/null
  sleep 2
  shot "$pid" 2-connected
  grep -E 'starting Runtime Hosts|spawned Runtime Host candidate|started Runtime Host process|connected to Runtime Host|connection catalog' "$RUN/step2.log"
  echo "rootId $(root_id)"
  show_registration
  local p
  for p in "$pid" "$(host_pid)"; do
    echo "pid $p provider keys in its environment: $(ps eww -o command= -p "$p" | tr ' ' '\n' \
      | grep -Ec '^(DEEPSEEK|ANTHROPIC|OPENAI)_API_KEY=' || true)"
  done
  if [[ -e "$ROOT/connection-catalog.json" ]]; then
    python3 -c 'import json,sys; c=json.load(open(sys.argv[1])); print("connection-catalog.json: revision", c["revision"], "connections", [x["slug"] for x in c["connections"]])' \
      "$ROOT/connection-catalog.json"
  else
    echo "no connection-catalog.json: the catalog is empty"
  fi
}

step_3() {
  say "3: add the Ollama connection through the Add connection form"
  local log="$RUN/step3.log" pid
  # --session names no task: after saving, the example waits 20 s for a
  # task's settings before it opens the model menu and then removes the
  # connection again. The screenshot is taken and the example stopped in
  # that window, so the saved connection stays.
  "${CLEAN_ENV[@]}" "$EX/live_add_connection" --root "$ROOT" --slug "$SLUG" \
    --session no-such-task --hold 20 2>"$log" &
  pid=$!
  echo "live_add_connection pid $pid"
  wait_line "$log" 'holding 20 s with the verified models' 90
  sleep 2
  shot "$pid" 3-form-verified
  wait_line "$log" "the model menu's catalog lists" 90
  sleep 1.5
  shot "$pid" 3-form-saved
  stop "$pid" live_add_connection
  grep -E 'connection.onboarding|live_add_connection|connection.catalog' "$log"
  say "3: Settings › Connections in the bundle"
  stop "$APP_PID" "the bundle"
  pid="$(launch "$RUN/step3-settings.log" --root "$ROOT" --open-settings connections)"
  remember APP_PID "$pid"
  wait_line "$RUN/step3-settings.log" 'connection catalog at revision' 60
  sleep 3
  shot "$pid" 3-settings-connections
}

step_6() {
  say "6: switch to phi4:latest and back through Composer::select_model (live_turn)"
  local log="$RUN/step6.log" back pid
  back="$(grep -Eo "catalog after saving: revision [0-9]+, default Some\(\"[^ ]+ [^\"]+\"\)" "$RUN/step3.log" \
    | sed -E 's/.* ([^ ]+)"\)$/\1/')"
  echo "the catalog default model (what a new task gets): $back"
  "${CLEAN_ENV[@]}" "$EX/live_turn" --root "$ROOT" --workspace "$WS" \
    --prompt "Say hello in one sentence." \
    --switch "$SLUG/phi4:latest" --switch "$SLUG/$back" 2>"$log" &
  pid=$!
  echo "live_turn pid $pid"
  # No screenshot: live_turn does not activate its window, which stays
  # behind the bundle's and is not redrawn. The evidence is the log.
  wait "$pid" || true
  grep -E 'live_turn: (created|choosing|session.catalog|turn |  )|configuration' "$log"
  remember BOOT_ID "$(grep -Eo 'created session [0-9a-f-]+' "$log" | head -1 | awk '{print $3}')"
}

step_4() {
  say "4: register the project and create a task with ⌘N (live_sidebar)"
  local log="$RUN/step4-sidebar.log" pid
  "${CLEAN_ENV[@]}" "$EX/live_sidebar" --root "$ROOT" --register "$WS" --new-task --hold 6 2>"$log" &
  pid=$!
  echo "live_sidebar pid $pid"
  wait_line "$log" 'holding|live_sidebar: .*(failed|was not)' 120
  if grep -q '⌘N created and selected' "$log"; then shot "$pid" 4-new-task; fi
  wait "$pid" || true
  grep -E 'live_sidebar|project.catalog' "$log"
  remember TASK_ID "$(grep -Eo 'created and selected Some\(\("[0-9a-f-]+' "$log" | grep -Eo '[0-9a-f-]{36}')"
  echo "task $TASK_ID"
  say "4: --send the tool prompt in the bundle"
  stop "$APP_PID" "the bundle"
  pid="$(launch "$RUN/step4-send.log" --root "$ROOT" --session "$TASK_ID" --send "$TOOL_PROMPT")"
  remember APP_PID "$pid"
  wait_line "$RUN/step4-send.log" 'the message started turn' 90
  wait_line "$RUN/step4-send.log" 'turn [^ ]+ finished' 300
  sleep 3
  shot "$pid" 4-transcript
  grep -E 'turn\.message|started turn|finished|added|--send' "$RUN/step4-send.log"
}

step_4b() {
  say "4b: the tool prompt on qwen2.5:7b (live_turn), then opened in the bundle"
  local log="$RUN/step4b.log" pid
  # The catalog default is the form's first model; qwen3:0.6b answered the
  # tool prompt without calling a tool, and the ⌘N task's model can only be
  # changed by clicking. live_turn switches its own task through
  # Composer::select_model before the turn.
  "${CLEAN_ENV[@]}" "$EX/live_turn" --root "$ROOT" --workspace "$WS" --prompt "$TOOL_PROMPT" \
    --switch "$SLUG/qwen2.5:7b" --allow 2>"$log" &
  pid=$!
  echo "live_turn pid $pid"
  wait "$pid" || true
  grep -E 'live_turn: (created|choosing|session.catalog|turn |  )' "$log"
  remember TOOL_ID "$(grep -Eo 'created session [0-9a-f-]+' "$log" | head -1 | awk '{print $3}')"
  stop "$APP_PID" "the bundle"
  pid="$(launch "$RUN/step4b-open.log" --root "$ROOT" --session "$TOOL_ID")"
  remember APP_PID "$pid"
  wait_line "$RUN/step4b-open.log" "session $TOOL_ID: subscription .* open" 60
  sleep 4
  shot "$pid" 4-tool-transcript
}

step_5() {
  say "5: a long turn and a follow-up sent while it runs"
  local log="$RUN/step5.log" pid
  stop "$APP_PID" "the bundle"
  pid="$(launch "$log" --root "$ROOT" --session "$TASK_ID" --send "$COUNT_PROMPT" --send "$FOLLOWUP_PROMPT")"
  remember APP_PID "$pid"
  wait_line "$log" 'queued as a follow-up' 120
  sleep 0.8
  shot "$pid" 5-queued
  wait_count "$log" 'turn [^ ]+ finished' 2 400
  sleep 3
  shot "$pid" 5-after
  grep -E 'started turn|queued|finished|queue' "$log"
}

step_6b() {
  say "6b: the bundle's model menu on the ⌘N task"
  local log="$RUN/step6b.log" pid
  stop "$APP_PID" "the bundle"
  pid="$(launch "$log" --root "$ROOT" --session "$TASK_ID" --open-model-menu)"
  remember APP_PID "$pid"
  wait_line "$log" 'connection catalog at revision' 60
  sleep 4
  shot "$pid" 6-model-menu
}

step_7() {
  say "7: quit, wait for the ephemeral Host to exit, relaunch"
  local reg hpid start pid
  reg="$(registration)"
  hpid="$(host_pid)"
  echo "Host pid $hpid, $(ps -o command= -p "$hpid" | cut -c1-160)"
  start=$SECONDS
  stop "$APP_PID" "the bundle"
  while [[ -e "$reg" ]] && ((SECONDS - start < 150)); do sleep 1; done
  if [[ -e "$reg" ]]; then
    echo "registration still present after $((SECONDS - start)) s" >&2
    return 1
  fi
  echo "registration removed $((SECONDS - start)) s after the app quit"
  kill -0 "$hpid" 2>/dev/null && echo "Host pid $hpid still running" || echo "Host pid $hpid has exited"
  ls -la "$(control_dir)"
  pid="$(launch "$RUN/step7.log" --root "$ROOT" --session "$TASK_ID")"
  remember APP_PID "$pid"
  wait_line "$RUN/step7.log" 'connected to Runtime Host' 90
  wait_line "$RUN/step7.log" "session $TASK_ID: subscription .* open" 60
  sleep 4
  shot "$pid" 7-relaunch
  grep -E 'spawned Runtime Host candidate|started Runtime Host process|connected to Runtime Host|session catalog|opening a subscription' "$RUN/step7.log"
}

step_8() {
  say "8: relaunch in zh-CN"
  local pid
  stop "$APP_PID" "the bundle"
  pid="$(launch "$RUN/step8.log" --root "$ROOT" --session "$TASK_ID" --locale zh-CN)"
  remember APP_PID "$pid"
  wait_line "$RUN/step8.log" 'connected to Runtime Host' 90
  sleep 5
  shot "$pid" 8-zh-CN
  grep -E 'spawned Runtime Host candidate|connected to Runtime Host' "$RUN/step8.log"
}

step_cleanup() {
  say "cleanup"
  local reg="" start
  [[ -e "$ROOT/.maka-storage-root.json" ]] && reg="$(registration)"
  stop "${APP_PID:-}" "the bundle"
  if [[ -n "$reg" ]]; then
    start=$SECONDS
    while [[ -e "$reg" ]] && ((SECONDS - start < 150)); do sleep 1; done
    [[ -e "$reg" ]] && { echo "the Host did not exit; not deleting the root" >&2; return 1; }
    echo "the Host exited $((SECONDS - start)) s after the last client quit"
  fi
  local left
  left="$(pgrep -fl "$ROOT" || true)"
  if [[ -n "$left" ]]; then
    echo "still running on the root: $left" >&2
    return 1
  fi
  rm -rf "$ROOT"
  echo "deleted $ROOT"
  local remembered="$HOME/Library/Application Support/maka-gpui/state-root.json"
  [[ -e "$remembered" ]] && echo "state-root.json exists: $(cat "$remembered")" || echo "state-root.json still absent"
  ls "$HOME/Library/Application Support/maka-gpui/"
}

(($#)) || { sed -n '2,/^set -euo/p' "$0" | sed '$d'; exit 2; }
for step in "$@"; do
  "step_$step"
done
