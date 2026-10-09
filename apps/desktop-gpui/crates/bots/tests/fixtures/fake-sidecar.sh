#!/bin/sh
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

# A stand-in for sidecars/bots/main.mjs that speaks the stdio protocol
# (docs/bots-sidecar.md) without Node or Maka, for crates/bots/tests/supervisor.rs.
#
# FAKE_SIDECAR_LOG   file that gets one line per command: "<pid> <command line>"
# FAKE_SIDECAR_MODE  normal | fatal | silent | stubborn (ignores shutdown)
#                    | mute (never answers apply_settings)
# FAKE_SIDECAR_CRASH_ONCE  a file; when it does not exist yet, the sidecar
#                    creates it and exits 3 on its first test_channel
mode="${FAKE_SIDECAR_MODE:-normal}"
case "$mode" in
  fatal)
    echo '{"event":"fatal","code":"checkout_unavailable","message":"@maka/runtime/bots is not built in the Maka checkout at /nowhere"}'
    exit 2 ;;
  silent)
    exec sleep 600 ;;
esac
echo "{\"event\":\"log\",\"level\":\"info\",\"message\":\"fake sidecar $$ starting\"}"
echo "{\"event\":\"ready\",\"protocol\":1,\"compatibilityEpoch\":197,\"pid\":$$}"
status() {
  printf '{"status":{"platform":"telegram","running":%s,"readiness":"%s","connection":"%s"}}' "$1" "$2" "$3"
}
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/^{"id":\([0-9]*\),.*/\1/p')
  command=$(printf '%s' "$line" | sed -n 's/^{"id":[0-9]*,"command":"\([a-z_]*\)".*/\1/p')
  [ -n "$FAKE_SIDECAR_LOG" ] && printf '%s %s\n' "$$" "$line" >> "$FAKE_SIDECAR_LOG"
  case "$command" in
    apply_settings)
      [ "$mode" = mute ] && continue
      echo "{\"event\":\"status\",$(status true credentials_valid polling | cut -c2-)"
      echo "{\"id\":$id,\"ok\":true}" ;;
    set_workspace)
      echo "{\"id\":$id,\"ok\":true}" ;;
    list_statuses | restart_listeners)
      echo "{\"id\":$id,\"ok\":true,\"statuses\":[$(status true credentials_valid polling)]}" ;;
    test_channel)
      if [ -n "$FAKE_SIDECAR_CRASH_ONCE" ] && [ ! -e "$FAKE_SIDECAR_CRASH_ONCE" ]; then
        : > "$FAKE_SIDECAR_CRASH_ONCE"
        exit 3
      fi
      echo "{\"id\":$id,\"ok\":true,\"result\":{\"ok\":true,\"identity\":{\"id\":\"4242\",\"username\":\"maka_test_bot\"},\"messageSent\":false}}" ;;
    shutdown)
      [ "$mode" = stubborn ] && continue
      echo "{\"event\":\"host\",\"state\":\"disconnected\",\"reason\":\"stopped\"}"
      echo "{\"id\":$id,\"ok\":true}"
      exit 0 ;;
    *)
      echo "{\"id\":$id,\"ok\":false,\"error\":{\"code\":\"unknown_command\",\"message\":\"Unknown command\"}}" ;;
  esac
done
# stdin closed: the client is gone.
exit 0
